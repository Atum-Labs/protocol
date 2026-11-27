// SPDX-License-Identifier: MIT

//! Storage keys and the TTL policy.
//!
//! TTL POLICY. A persistent entry that outlives its TTL is archived and cannot be read until
//! someone restores it, so a live deposit must never be left to lapse. Every entry the escrow
//! relies on is therefore extended to the network maximum whenever it is written or read by a
//! state-changing call, with a threshold so a fresh entry is not re-extended (and re-rented) on
//! every touch. The nonce word is the one exception: it keeps the network minimum TTL it is created with.
//! Deposits have no on-chain expiry (the releaser can refund at any time), so the
//! per-touch extension is not enough on its own: `extend_deposit_ttl` is a permissionless
//! keep-alive that the settler, the depositor or any monitor must call at least once per
//! `max TTL - BUMP_WINDOW`. An archived entry is restorable with a `RestoreFootprint` operation
//! and its state is intact, so the failure mode is "blocked until restored", not "funds lost"; a
//! nonce bitmap cannot be recreated while archived, so archival never re-opens a used nonce.
//! The instance bump also extends the contract code entry: the SDK's `Instance::extend_ttl` applies the
//! same threshold and extension to both. A keeper (`extend-ttl`) must still run at least once per bump
//! window, or the next caller that crosses the threshold pays the code's rent as well as its own fee.
//! The tokens themselves sit in the escrow's `Balance` entry inside each token contract, which this
//! contract cannot extend and `extend_deposit_ttl` does not touch: a Stellar Asset Contract extends it
//! only to 30 days, and only when the escrow's own balance is read or written. The `extend-ttl` keeper
//! extends that entry for every token `get_allowed_tokens` returns at run time, and must run at least once per 30 days.

use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::types::Role;

/// ~1 day of ledgers at the 5 s close time. Used only to size the window below.
pub const DAY_IN_LEDGERS: u32 = 17_280;
/// Extend only when less than the maximum minus this window remains.
pub const BUMP_WINDOW: u32 = 7 * DAY_IN_LEDGERS;

#[contracttype]
pub enum DataKey {
    // Instance
    DefaultAdmin,
    PendingAdmin,
    AdminDelay,
    PendingDelay,
    Paused,
    // Persistent
    Role(Role, Address),
    TokenConfig(Address),
    AllowedTokens,
    FeeRevenue(Address),
    /// deposit id -> hash of the `ActiveDeposit`
    ActiveDeposit(BytesN<32>),
    /// (owner, token, nonce >> 7) -> bitmap; a set bit is never cleared
    Nonce(Address, Address, u64),
    /// (depositor, token) -> `Delegate`
    Delegate(Address, Address),
    /// (depositor, token) -> last epoch issued; outlives the record so epochs never repeat
    DelegateEpoch(Address, Address),
    /// (reserver, quote hash) -> true once a deposit the reserver signed was accepted under that
    /// quote; never cleared
    QuoteUsed(BytesN<32>, BytesN<32>),
}

pub fn bump_instance(env: &Env) {
    let max = env.storage().max_ttl();
    env.storage()
        .instance()
        .extend_ttl(max.saturating_sub(BUMP_WINDOW), max);
}

pub fn bump(env: &Env, key: &DataKey) {
    let max = env.storage().max_ttl();
    env.storage()
        .persistent()
        .extend_ttl(key, max.saturating_sub(BUMP_WINDOW), max);
}

/// Read a persistent entry and extend it, so a read that a call depends on also keeps it alive.
/// A call that writes the same key back with `set_persistent` reads with the plain storage `get`
/// instead: the write extends it, and a second `extend_ttl` is a wasted host call.
pub fn get_persistent<V>(env: &Env, key: &DataKey) -> Option<V>
where
    V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>,
{
    let v = env.storage().persistent().get(key);
    if v.is_some() {
        bump(env, key);
    }
    v
}

pub fn set_persistent<V>(env: &Env, key: &DataKey, value: &V)
where
    V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
{
    env.storage().persistent().set(key, value);
    bump(env, key);
}
