// SPDX-License-Identifier: MIT
#![no_std]
//! Atum Protocol escrow for Soroban.
//!
//! Behaviour follows the EVM `Escrow` (the source of truth); byte framing of signed messages
//! follows the Solana port. `docs/DECISIONS.md` lists every place the Stellar model forced a
//! choice, `docs/witness-layouts.md` is the byte-exact contract for the off-chain encoders.
//!
//! No upgrade entrypoint exists: a new version is a new contract id.

#[cfg(test)]
extern crate std;

mod access;
mod errors;
mod events;
mod fees;
mod signatures;
mod storage;
mod types;

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_anchors;
#[cfg(test)]
mod test_conformance;
#[cfg(test)]
mod test_fees;

use soroban_sdk::{contract, contractimpl, token, vec, Address, BytesN, Env, Vec};

pub use errors::Error;
pub use types::*;

use storage::{bump, bump_instance, get_persistent, set_persistent, DataKey};

#[contract]
pub struct Escrow;

/// A deposit's deadline may be at most this far past its `issued_at`.
const MAX_DEPOSIT_VALIDITY_SECS: u64 = 24 * 60 * 60;

#[contractimpl]
impl Escrow {
    /// `admin_delay_secs` is the initial delay of the default-admin transfer. The EVM deployment
    /// starts at 1 second so the deployer can hand over to the multisig at once, then raises it
    /// with `change_default_admin_delay`; the same sequence applies here.
    pub fn __constructor(env: Env, default_admin: Address, admin_delay_secs: u32) {
        env.storage()
            .instance()
            .set(&DataKey::DefaultAdmin, &default_admin);
        env.storage()
            .instance()
            .set(&DataKey::AdminDelay, &admin_delay_secs);
        bump_instance(&env);
        events::Initialized {
            default_admin,
            admin_delay_secs,
        }
        .publish(&env);
    }

    // ---------------------------------------------------------------- escrow

    /// Pulls `reserve_witness.source_amount` of `token` from the depositor and stores the active
    /// deposit hash under the deposit id, which is the deposit digest (see witness-layouts.md).
    pub fn deposit(env: Env, input: DepositInput) -> Result<BytesN<32>, Error> {
        bump_instance(&env);
        access::require_not_paused(&env)?;
        // No depositor `require_auth`: the depositor pre-authorised through a delegate record and a
        // SEP-41 allowance, and the delegate signer's signature below binds this exact deposit.

        let config: TokenConfig = get_persistent(&env, &DataKey::TokenConfig(input.token.clone()))
            .ok_or(Error::TokenNotAllowed)?;
        let w = &input.deposit_witness;
        let r = &input.reserve_witness;

        // The witness and amount checks follow `_requireDepositWitness`, `_requireReserveWitness`
        // and `_deposit`. The order differs from EVM in one place: EVM runs `determineFee` before
        // these checks, here the fee is computed after them (below), so a negative source
        // amount returns `InvalidSourceAmount` here, where running the fee first would return
        // `InvalidAmount` (from `determine_fee`).
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        if w.reserver == zero {
            return Err(Error::ReserverCannotBeZero);
        }
        if w.releaser == zero {
            return Err(Error::ReleaserCannotBeZero);
        }
        if w.deposit_request_hash == zero {
            return Err(Error::DepositRequestHashCannotBeEmpty);
        }
        let dest_len = w.destination.len();
        if dest_len == 0 {
            return Err(Error::DestinationCannotBeEmpty);
        }
        if dest_len > signatures::MAX_DESTINATION_BYTES {
            return Err(Error::DestinationTooLong);
        }
        if r.quote_hash == zero {
            return Err(Error::QuoteHashCannotBeEmpty);
        }
        // `release` would transfer from the escrow to itself, a balance no-op that strands the payout
        if r.settler == env.current_contract_address() {
            return Err(Error::SettlerCannotBeSelf);
        }
        if input.amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        // The winning source amount is the charge; `amount` is only the authorised ceiling
        if r.source_amount <= 0 || r.source_amount > input.amount {
            return Err(Error::InvalidSourceAmount);
        }
        let fee_amount = fees::determine_fee(r.source_amount, &config)?;

        let now = env.ledger().timestamp();
        if input.issued_at > input.deadline {
            return Err(Error::InconsistentTimestamps);
        }
        if input.deadline < now {
            return Err(Error::DeadlineExpired);
        }
        if input.issued_at > now {
            return Err(Error::FutureDeposit);
        }
        if input.deadline - input.issued_at > MAX_DEPOSIT_VALIDITY_SECS {
            return Err(Error::DeadlineTooFarInFuture);
        }
        use_nonce(&env, &input.depositor, &input.token, input.nonce)?;

        // Read first: the digest binds the record's epoch
        let dkey = DataKey::Delegate(input.depositor.clone(), input.token.clone());
        let mut delegate: Delegate = env
            .storage()
            .persistent()
            .get(&dkey)
            .ok_or(Error::DelegateNotFound)?;

        let domain = signatures::Domain::current(&env);
        let destination_hash = signatures::destination_hash(&env, &w.destination);
        let deposit_id = signatures::compute_deposit_hash(
            &env,
            &domain,
            &w.deposit_request_hash,
            &destination_hash,
            &input.depositor,
            &input.token,
            delegate.epoch,
            input.amount,
            &w.reserver,
            &w.releaser,
            input.nonce,
            input.issued_at,
            input.deadline,
        );
        if r.deposit_id != deposit_id {
            return Err(Error::DepositIdMismatch);
        }

        // Delegate checks, in Solana's spirit: expiry, per-transfer max, remaining capacity. They
        // apply to the amount actually pulled, as Solana's apply to the amount it pulls.
        if now >= delegate.expiration {
            return Err(Error::DelegateExpired);
        }
        if r.source_amount > delegate.max_transfer_size {
            return Err(Error::DelegateOverTransferMax);
        }
        if r.source_amount > delegate.remaining_capacity {
            return Err(Error::DelegateOverCapacity);
        }
        // Before any funds move; traps on a bad signature
        signatures::verify(
            &env,
            &delegate.delegate_signer,
            &deposit_id,
            &input.delegate_signature,
        );
        delegate.remaining_capacity -= r.source_amount;
        set_persistent(&env, &dkey, &delegate);

        let active = ActiveDeposit {
            depositor: input.depositor.clone(),
            quote_hash: r.quote_hash.clone(),
            deposit_request_hash: w.deposit_request_hash.clone(),
            destination_hash: destination_hash.clone(),
            token: input.token.clone(),
            amount: r.source_amount,
            fee_amount,
            reserver: w.reserver.clone(),
            releaser: w.releaser.clone(),
            settler: r.settler.clone(),
        };
        // Rejects a still-active duplicate only. Re-use of a completed id is prevented by the
        // never-cleared nonce above, exactly as Permit2's nonce does on EVM: an id commits to the
        // nonce, so replaying it replays a spent nonce.
        let key = DataKey::ActiveDeposit(deposit_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::DepositAlreadyExists);
        }
        // One quote awarded by a reserver backs at most one deposit, live or completed
        let quote_key = DataKey::QuoteUsed(w.reserver.clone(), r.quote_hash.clone());
        if env.storage().persistent().has(&quote_key) {
            return Err(Error::QuoteAlreadyUsed);
        }
        set_persistent(&env, &quote_key, &true);
        set_persistent(
            &env,
            &key,
            &signatures::compute_active_deposit_hash(&env, &active),
        );

        // Reserve signature before the token call, so the external call happens last
        let reserve_digest = signatures::compute_reserve_hash(
            &env,
            &domain,
            &deposit_id,
            &r.quote_hash,
            &r.settler,
            r.source_amount,
        );
        signatures::verify(&env, &w.reserver, &reserve_digest, &input.reserve_signature);

        // Measured, not trusted: a fee-on-transfer or inflating token would otherwise leave the
        // pooled balance short of, or above, what the stored deposits account for.
        let escrow = env.current_contract_address();
        let client = token::Client::new(&env, &input.token);
        let before = client.balance(&escrow);
        // Spends the depositor's SEP-41 allowance to the escrow; reverts if missing or too small
        client.transfer_from(&escrow, &input.depositor, &escrow, &r.source_amount);
        if client.balance(&escrow) - before != r.source_amount {
            return Err(Error::NonExactTransfer);
        }

        events::Deposited {
            deposit_id: deposit_id.clone(),
            quote_hash: r.quote_hash.clone(),
            depositor: input.depositor.clone(),
            settler: r.settler.clone(),
            token: input.token.clone(),
            amount: r.source_amount,
            fee_amount,
            reserver: w.reserver.clone(),
            releaser: w.releaser.clone(),
        }
        .publish(&env);
        events::DepositCommitments {
            deposit_id: deposit_id.clone(),
            deposit_request_hash: w.deposit_request_hash.clone(),
            destination_hash,
        }
        .publish(&env);
        Ok(deposit_id)
    }

    /// Pays the settler `amount - fee_amount` and books the fee. Permissionless: the releaser's
    /// signature over the eleven-member witness is the authority.
    pub fn release(env: Env, witness: ReleaseWitness, signature: BytesN<64>) -> Result<(), Error> {
        bump_instance(&env);
        access::require_not_paused(&env)?;
        if witness.quote_hash == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(Error::QuoteHashCannotBeEmpty);
        }
        let active = ActiveDeposit::from(&witness);
        // Storage is cleared first: a second call finds nothing, which is the replay protection
        consume_active_deposit(&env, &witness.deposit_id, &active)?;
        let digest = signatures::compute_release_hash(
            &env,
            &signatures::Domain::current(&env),
            &witness.deposit_id,
            &active,
        );
        signatures::verify(&env, &witness.releaser, &digest, &signature);

        // Effect before the outbound transfer
        let key = DataKey::FeeRevenue(witness.token.clone());
        let revenue: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        set_persistent(&env, &key, &(revenue + witness.fee_amount));

        token::Client::new(&env, &witness.token).transfer(
            &env.current_contract_address(),
            &witness.settler,
            &(witness.amount - witness.fee_amount),
        );
        events::Released {
            deposit_id: witness.deposit_id,
            settler: witness.settler,
            token: witness.token,
            amount: witness.amount,
            fee_amount: witness.fee_amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Returns the full `amount` to the depositor; the fee is only taken on release.
    pub fn refund(env: Env, witness: RefundWitness, signature: BytesN<64>) -> Result<(), Error> {
        bump_instance(&env);
        access::require_not_paused(&env)?;
        if witness.quote_hash == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(Error::QuoteHashCannotBeEmpty);
        }
        let active = ActiveDeposit::from(&witness);
        consume_active_deposit(&env, &witness.deposit_id, &active)?;
        let digest = signatures::compute_refund_hash(
            &env,
            &signatures::Domain::current(&env),
            &witness.deposit_id,
            &active,
        );
        signatures::verify(&env, &witness.releaser, &digest, &signature);

        token::Client::new(&env, &witness.token).transfer(
            &env.current_contract_address(),
            &witness.depositor,
            &witness.amount,
        );
        events::Refunded {
            deposit_id: witness.deposit_id,
            depositor: witness.depositor,
            token: witness.token,
            amount: witness.amount,
        }
        .publish(&env);
        Ok(())
    }

    // ---------------------------------------------------------------- delegate

    /// The depositor pre-authorises deposits of `token` signed by `delegate_signer`, within
    /// `capacity` in total and `max_transfer_size` each, until `expiration` (ledger time).
    /// Setup also needs the depositor's `token.approve(depositor, escrow, amount, expiration_ledger)`,
    /// done off-contract: this call does not make it. One record per (depositor, token); revoke
    /// before creating another, as Solana's account `init` implies.
    ///
    /// Returns the epoch the new record took (see `Delegate::epoch`), which every deposit and renounce
    /// digest for the record commits to; `DelegateCreated` carries it too.
    pub fn create_delegate(
        env: Env,
        depositor: Address,
        token: Address,
        delegate_signer: BytesN<32>,
        capacity: i128,
        max_transfer_size: i128,
        expiration: u64,
    ) -> Result<u64, Error> {
        bump_instance(&env);
        access::require_not_paused(&env)?;
        depositor.require_auth();
        if !env
            .storage()
            .persistent()
            .has(&DataKey::TokenConfig(token.clone()))
        {
            return Err(Error::TokenNotAllowed);
        }
        if capacity <= 0 || max_transfer_size <= 0 || max_transfer_size > capacity {
            return Err(Error::DelegateLimitsInvalid);
        }
        if delegate_signer == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(Error::InvalidDelegateSigner);
        }
        if expiration <= env.ledger().timestamp() {
            return Err(Error::InvalidExpiration);
        }
        let key = DataKey::Delegate(depositor.clone(), token.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::DelegateAlreadyExists);
        }
        let ekey = DataKey::DelegateEpoch(depositor.clone(), token.clone());
        let epoch: u64 = env.storage().persistent().get(&ekey).unwrap_or(0) + 1;
        set_persistent(&env, &ekey, &epoch);
        set_persistent(
            &env,
            &key,
            &Delegate {
                epoch,
                delegate_signer: delegate_signer.clone(),
                remaining_capacity: capacity,
                max_transfer_size,
                expiration,
            },
        );
        events::DelegateCreated {
            depositor,
            token,
            delegate_signer,
            capacity,
            max_transfer_size,
            expiration,
            epoch,
        }
        .publish(&env);
        Ok(epoch)
    }

    /// Deletes the record, so no further deposit can use the allowance. Not pause-gated: a user must
    /// always be able to withdraw authority. The depositor should also set the SEP-41 allowance to 0.
    pub fn revoke_delegate(env: Env, depositor: Address, token: Address) -> Result<(), Error> {
        bump_instance(&env);
        depositor.require_auth();
        let key = DataKey::Delegate(depositor.clone(), token.clone());
        let d: Delegate = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::DelegateNotFound)?;
        env.storage().persistent().remove(&key);
        events::DelegateRevoked {
            depositor,
            token,
            delegate_signer: d.delegate_signer,
            epoch: d.epoch,
        }
        .publish(&env);
        Ok(())
    }

    /// The delegate signer gives up its authority: capacity to zero, expiry to now, as Solana's
    /// `renounce_delegate`. The signer is a raw key and cannot `require_auth`, so it proves itself with
    /// a signature over the renounce digest; the nonce comes from the bitmap of the depositor and
    /// token, so the signature is single-use, and the signature stops being accepted after `deadline`
    /// (ledger time, seconds, signed), so one that leaks unused cannot be submitted later. Anyone may
    /// submit it. The record stays until the depositor revokes it.
    pub fn renounce_delegate(
        env: Env,
        depositor: Address,
        token: Address,
        nonce: u64,
        deadline: u64,
        signature: BytesN<64>,
    ) -> Result<(), Error> {
        bump_instance(&env);
        if deadline < env.ledger().timestamp() {
            return Err(Error::DeadlineExpired);
        }
        let key = DataKey::Delegate(depositor.clone(), token.clone());
        let mut d: Delegate = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::DelegateNotFound)?;
        use_nonce(&env, &depositor, &token, nonce)?;
        let digest = signatures::compute_renounce_hash(
            &env,
            &signatures::Domain::current(&env),
            &depositor,
            &token,
            d.epoch,
            nonce,
            deadline,
        );
        signatures::verify(&env, &d.delegate_signer, &digest, &signature);
        d.remaining_capacity = 0;
        d.expiration = env.ledger().timestamp();
        set_persistent(&env, &key, &d);
        events::DelegateRenounced {
            depositor,
            token,
            delegate_signer: d.delegate_signer,
            epoch: d.epoch,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_delegate(env: Env, depositor: Address, token: Address) -> Option<Delegate> {
        env.storage()
            .persistent()
            .get(&DataKey::Delegate(depositor, token))
    }

    /// Permissionless keep-alive: extends a live deposit's entry (and the instance) to the maximum
    /// TTL. See the TTL policy in `storage.rs`.
    pub fn extend_deposit_ttl(env: Env, deposit_id: BytesN<32>) -> Result<(), Error> {
        bump_instance(&env);
        let key = DataKey::ActiveDeposit(deposit_id);
        if !env.storage().persistent().has(&key) {
            return Err(Error::DepositNotFound);
        }
        bump(&env, &key);
        Ok(())
    }

    pub fn get_deposit_hash(env: Env, deposit_id: BytesN<32>) -> Option<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::ActiveDeposit(deposit_id))
    }

    // ----------------------------------------------------------- token config

    pub fn determine_fee(_env: Env, amount: i128, config: TokenConfig) -> Result<i128, Error> {
        fees::determine_fee(amount, &config)
    }

    pub fn get_token_config(env: Env, token: Address) -> Option<TokenConfig> {
        env.storage().persistent().get(&DataKey::TokenConfig(token))
    }

    pub fn is_token_allowed(env: Env, token: Address) -> bool {
        env.storage().persistent().has(&DataKey::TokenConfig(token))
    }

    // A view that also extends the list's TTL, so it keeps the entry alive like any other read.
    pub fn get_allowed_tokens(env: Env) -> Vec<Address> {
        get_persistent(&env, &DataKey::AllowedTokens).unwrap_or(vec![&env])
    }

    pub fn get_fee_revenue(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::FeeRevenue(token))
            .unwrap_or(0)
    }

    /// Opens `deposit` for `token` at a zero fee schedule, immediately: every deposit accepted before
    /// `set_token_fee_config` runs keeps a zero fee, because the fee is fixed in the stored deposit.
    /// A token that was disallowed comes back with zero fees, not its previous schedule, and
    /// `TokenAllowed` carries no fee fields. Prefer `allow_token_and_set_fee_config`.
    pub fn allow_token(
        env: Env,
        caller: Address,
        token: Address,
        decimals: u32,
    ) -> Result<(), Error> {
        bump_instance(&env);
        access::require_role(&env, Role::TokenConfig, &caller)?;
        allow_token(&env, &token, decimals)
    }

    pub fn set_token_fee_config(
        env: Env,
        caller: Address,
        token: Address,
        fee_percentage_6: u32,
        min_fee_6: u64,
        max_fee_6: u64,
    ) -> Result<(), Error> {
        bump_instance(&env);
        access::require_role(&env, Role::TokenConfig, &caller)?;
        set_token_fee_config(&env, &token, fee_percentage_6, min_fee_6, max_fee_6)
    }

    /// The preferred way to allow a token: no deposit can land between allowing it and setting its fees.
    pub fn allow_token_and_set_fee_config(
        env: Env,
        caller: Address,
        token: Address,
        decimals: u32,
        fee_percentage_6: u32,
        min_fee_6: u64,
        max_fee_6: u64,
    ) -> Result<(), Error> {
        bump_instance(&env);
        access::require_role(&env, Role::TokenConfig, &caller)?;
        allow_token(&env, &token, decimals)?;
        set_token_fee_config(&env, &token, fee_percentage_6, min_fee_6, max_fee_6)
    }

    pub fn clear_token_fee_config(env: Env, caller: Address, token: Address) -> Result<(), Error> {
        bump_instance(&env);
        access::require_role(&env, Role::TokenConfig, &caller)?;
        let key = DataKey::TokenConfig(token.clone());
        let mut config: TokenConfig = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TokenNotAllowed)?;
        config.fee_percentage_6 = 0;
        config.min_fee_6 = 0;
        config.max_fee_6 = 0;
        set_persistent(&env, &key, &config);
        events::TokenFeesCleared { token }.publish(&env);
        Ok(())
    }

    /// Deposits already in flight stay releasable and refundable: settlement never consults the
    /// allowlist, as on EVM.
    /// Deletes the token's whole config, fee schedule included; allowing it again starts from zero fees.
    pub fn disallow_token(env: Env, caller: Address, token: Address) -> Result<(), Error> {
        bump_instance(&env);
        access::require_role(&env, Role::TokenConfig, &caller)?;
        let key = DataKey::TokenConfig(token.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::TokenNotAllowed);
        }
        env.storage().persistent().remove(&key);
        let mut kept = vec![&env];
        for t in allowed_tokens(&env).iter() {
            if t != token {
                kept.push_back(t);
            }
        }
        set_persistent(&env, &DataKey::AllowedTokens, &kept);
        events::TokenDisallowed { token }.publish(&env);
        Ok(())
    }

    pub fn withdraw_fee_revenue(
        env: Env,
        caller: Address,
        token: Address,
        recipient: Address,
    ) -> Result<(), Error> {
        bump_instance(&env);
        access::require_role(&env, Role::Treasurer, &caller)?;
        if recipient == env.current_contract_address() {
            return Err(Error::RecipientCannotBeSelf);
        }
        let key = DataKey::FeeRevenue(token.clone());
        let revenue: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if revenue <= 0 {
            return Err(Error::NoFeesToWithdraw);
        }
        set_persistent(&env, &key, &0i128);
        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &recipient,
            &revenue,
        );
        events::FeeRevenueWithdrawn {
            token,
            recipient,
            amount: revenue,
        }
        .publish(&env);
        Ok(())
    }

    // ------------------------------------------------------------------ pause

    pub fn pause(env: Env, caller: Address) -> Result<(), Error> {
        bump_instance(&env);
        access::require_role(&env, Role::Pauser, &caller)?;
        access::set_paused(&env, true, &caller)
    }

    pub fn unpause(env: Env, caller: Address) -> Result<(), Error> {
        bump_instance(&env);
        access::require_role(&env, Role::Pauser, &caller)?;
        access::set_paused(&env, false, &caller)
    }

    pub fn paused(env: Env) -> bool {
        access::is_paused(&env)
    }

    // ------------------------------------------------------------------ roles

    pub fn has_role(env: Env, role: Role, account: Address) -> bool {
        access::has_role(&env, role, &account)
    }

    pub fn grant_role(env: Env, role: Role, account: Address) {
        bump_instance(&env);
        let admin = access::require_default_admin(&env);
        if !access::has_role(&env, role, &account) {
            access::grant_role(&env, role, &account);
            events::RoleGranted {
                role,
                account,
                sender: admin,
            }
            .publish(&env);
        }
    }

    pub fn revoke_role(env: Env, role: Role, account: Address) {
        bump_instance(&env);
        let admin = access::require_default_admin(&env);
        if access::has_role(&env, role, &account) {
            access::revoke_role(&env, role, &account);
            events::RoleRevoked {
                role,
                account,
                sender: admin,
            }
            .publish(&env);
        }
    }

    pub fn renounce_role(env: Env, role: Role, account: Address) {
        bump_instance(&env);
        account.require_auth();
        if access::has_role(&env, role, &account) {
            access::revoke_role(&env, role, &account);
            events::RoleRevoked {
                role,
                account: account.clone(),
                sender: account,
            }
            .publish(&env);
        }
    }

    // ---------------------------------------------------------- default admin

    pub fn default_admin(env: Env) -> Address {
        access::default_admin(&env)
    }

    pub fn pending_default_admin(env: Env) -> Option<PendingAdmin> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    pub fn default_admin_delay(env: Env) -> u32 {
        access::delay_state(&env).0
    }

    pub fn pending_default_admin_delay(env: Env) -> Option<PendingDelay> {
        access::delay_state(&env).1
    }

    pub fn begin_default_admin_transfer(env: Env, new_admin: Address) -> Result<(), Error> {
        bump_instance(&env);
        access::require_default_admin(&env);
        access::begin_transfer(&env, new_admin)
    }

    pub fn cancel_default_admin_transfer(env: Env) -> Result<(), Error> {
        bump_instance(&env);
        access::require_default_admin(&env);
        access::cancel_transfer(&env)
    }

    pub fn accept_default_admin_transfer(env: Env) -> Result<(), Error> {
        bump_instance(&env);
        access::accept_transfer(&env)
    }

    pub fn change_default_admin_delay(env: Env, new_delay: u32) -> Result<(), Error> {
        bump_instance(&env);
        access::require_default_admin(&env);
        access::change_delay(&env, new_delay)
    }

    pub fn rollback_default_admin_delay(env: Env) -> Result<(), Error> {
        bump_instance(&env);
        access::require_default_admin(&env);
        access::rollback_delay(&env)
    }
}

/// Reads the list without extending it: both callers write it back with `set_persistent`, which
/// extends it. The `get_allowed_tokens` view reads with `get_persistent` instead, so it keeps the
/// entry alive; the SDK permits `extend_ttl` inside a read-only call.
fn allowed_tokens(env: &Env) -> Vec<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::AllowedTokens)
        .unwrap_or(vec![env])
}

/// The stored hash must exist and equal the hash of the tuple the caller rebuilt from its
/// witness; the entry is removed before any outbound transfer.
fn consume_active_deposit(
    env: &Env,
    deposit_id: &BytesN<32>,
    passed: &ActiveDeposit,
) -> Result<(), Error> {
    let key = DataKey::ActiveDeposit(deposit_id.clone());
    let stored: BytesN<32> = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::DepositNotFound)?;
    if stored != signatures::compute_active_deposit_hash(env, passed) {
        return Err(Error::InvalidWitnessValues);
    }
    env.storage().persistent().remove(&key);
    Ok(())
}

/// Permit2-style unordered nonce: one u128 word holds 128 nonces; a set bit is never cleared.
///
/// Deliberately not extended to the maximum TTL, unlike every other persistent entry: a deposit
/// signature stops being accepted at its deadline, at most 24 hours after it was issued, so nothing
/// needs the word to outlive its creation TTL. If it is archived anyway it is restored with its bits
/// set and cannot be recreated empty.
fn use_nonce(env: &Env, owner: &Address, token: &Address, nonce: u64) -> Result<(), Error> {
    let key = DataKey::Nonce(owner.clone(), token.clone(), nonce >> 7);
    let bit = 1u128 << (nonce & 0x7f);
    let word: u128 = env.storage().persistent().get(&key).unwrap_or(0);
    if word & bit != 0 {
        return Err(Error::NonceAlreadyUsed);
    }
    env.storage().persistent().set(&key, &(word | bit));
    Ok(())
}

fn allow_token(env: &Env, token: &Address, decimals: u32) -> Result<(), Error> {
    if decimals == 0 {
        return Err(Error::TokenDecimalsCannotBeZero);
    }
    if decimals > fees::MAX_TOKEN_DECIMALS {
        return Err(Error::TokenDecimalsExceedMaximum);
    }
    let key = DataKey::TokenConfig(token.clone());
    if env.storage().persistent().has(&key) {
        return Err(Error::TokenAlreadyAllowed);
    }
    // SEP-41 requires `decimals` and an asset contract always answers. A token that does not answer
    // is not deployed yet or is not a token, so it is refused rather than trusted.
    match token::Client::new(env, token).try_decimals() {
        Ok(Ok(actual)) if actual == decimals => {}
        _ => return Err(Error::TokenDecimalsMismatch),
    }
    set_persistent(
        env,
        &key,
        &TokenConfig {
            fee_percentage_6: 0,
            max_fee_6: 0,
            min_fee_6: 0,
            token_decimals: decimals,
        },
    );
    let mut list = allowed_tokens(env);
    list.push_back(token.clone());
    set_persistent(env, &DataKey::AllowedTokens, &list);
    events::TokenAllowed {
        token: token.clone(),
        decimals,
    }
    .publish(env);
    Ok(())
}

fn set_token_fee_config(
    env: &Env,
    token: &Address,
    fee_percentage_6: u32,
    min_fee_6: u64,
    max_fee_6: u64,
) -> Result<(), Error> {
    let key = DataKey::TokenConfig(token.clone());
    let mut config: TokenConfig = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::TokenNotAllowed)?;
    fees::validate_fee_config(
        fee_percentage_6,
        min_fee_6,
        max_fee_6,
        config.token_decimals,
    )?;
    config.fee_percentage_6 = fee_percentage_6;
    config.min_fee_6 = min_fee_6;
    config.max_fee_6 = max_fee_6;
    set_persistent(env, &key, &config);
    events::TokenFeesUpdated {
        token: token.clone(),
        fee_percentage_6,
        min_fee_6,
        max_fee_6,
    }
    .publish(env);
    Ok(())
}
