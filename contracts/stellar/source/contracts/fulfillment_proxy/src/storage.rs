use soroban_sdk::{contracttype, Address, BytesN, Env};

// Ledgers close about every 5s. Live entries are topped up whenever they fall under the threshold.
const DAY_IN_LEDGERS: u32 = 17_280;
/// Preferred horizon: the network's maximum entry TTL on mainnet and testnet (3,110,400 ledgers, about
/// 180 days), as the escrow extends. It must not be lower than the minimum persistent TTL on creation
/// (2,073,600 ledgers, about 120 days, on mainnet): a new entry starts at that minimum and `extend_ttl`
/// only acts when the current TTL is below its threshold, so a lower target would never run for a fresh
/// entry on mainnet. The actual extension is capped at the max entry TTL read from the ledger, because
/// the host rejects an extension past it and a fixed constant above a lower-max network would make every
/// `strict_fulfill` trap.
const TARGET_BUMP_AMOUNT: u32 = 180 * DAY_IN_LEDGERS;

/// `(threshold, extend_to)`: `extend_to` is the target capped at the network max; the threshold is
/// one day below it (half of it when the cap is under two days). With a large max TTL this is
/// exactly 180 days and 179 days.
fn ttl_window(env: &Env) -> (u32, u32) {
    let bump = TARGET_BUMP_AMOUNT.min(env.storage().max_ttl());
    (bump - DAY_IN_LEDGERS.min(bump / 2), bump)
}

#[contracttype]
pub(crate) enum DataKey {
    Config,
    PendingAdmin,
    PendingDelay,
    Settler(Address),
    /// (quote_hash, to, token, amount) -> true. Keyed on the payment, not the bare quote hash, so a
    /// call that pays a different recipient, token or amount only consumes its own key.
    StrictFulfilled(BytesN<32>, Address, Address, i128),
    /// (settler, nonce >> 7) -> bitmap; a set bit is never cleared
    SettlerNonce(Address, u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub pauser: Address,
    pub paused: bool,
    pub enforce_settler_allowlist: bool,
    pub delay_seconds: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdmin {
    pub admin: Address,
    pub accept_after: u64,
}

/// A scheduled change of the admin-transfer delay, as the escrow's `PendingDelay`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingDelay {
    pub new_delay: u32,
    /// Ledger timestamp after which `new_delay` is the current delay.
    pub effective_at: u64,
}

/// Extended on every entrypoint: config, pending admin and the contract's own instance live in
/// instance storage, which shares one TTL. The SDK's
/// `Instance::extend_ttl` extends the contract code entry too, under the same threshold, so a keeper that
/// does not run in time leaves the next caller paying the code's rent.
pub fn extend_instance(env: &Env) {
    let (threshold, bump) = ttl_window(env);
    env.storage().instance().extend_ttl(threshold, bump);
}

pub fn get_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .expect("not initialized")
}

pub fn set_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

pub fn get_pending_admin(env: &Env) -> Option<PendingAdmin> {
    env.storage().instance().get(&DataKey::PendingAdmin)
}

pub fn set_pending_admin(env: &Env, pending: Option<PendingAdmin>) {
    match pending {
        Some(p) => env.storage().instance().set(&DataKey::PendingAdmin, &p),
        None => env.storage().instance().remove(&DataKey::PendingAdmin),
    }
}

pub fn is_settler(env: &Env, settler: &Address) -> bool {
    let key = DataKey::Settler(settler.clone());
    let present = env.storage().persistent().has(&key);
    if present {
        let (threshold, bump) = ttl_window(env);
        env.storage().persistent().extend_ttl(&key, threshold, bump);
    }
    present
}

pub fn set_settler(env: &Env, settler: &Address, allowed: bool) {
    let key = DataKey::Settler(settler.clone());
    if allowed {
        env.storage().persistent().set(&key, &true);
        let (threshold, bump) = ttl_window(env);
        env.storage().persistent().extend_ttl(&key, threshold, bump);
    } else {
        env.storage().persistent().remove(&key);
    }
}

pub fn is_strictly_fulfilled(
    env: &Env,
    quote_hash: &BytesN<32>,
    to: &Address,
    token: &Address,
    amount: i128,
) -> bool {
    env.storage().persistent().has(&DataKey::StrictFulfilled(
        quote_hash.clone(),
        to.clone(),
        token.clone(),
        amount,
    ))
}

/// The marker is never cleared: no setter, no admin reset. An archived marker cannot be recreated
/// (its key stays occupied until restored), so archival can delay but not defeat idempotency.
pub fn set_strictly_fulfilled(
    env: &Env,
    quote_hash: &BytesN<32>,
    to: &Address,
    token: &Address,
    amount: i128,
) {
    let key = DataKey::StrictFulfilled(quote_hash.clone(), to.clone(), token.clone(), amount);
    env.storage().persistent().set(&key, &true);
    // Threshold equals the target, which is above the network's minimum persistent TTL, so a freshly
    // written marker is always topped up to the horizon.
    let (_, bump) = ttl_window(env);
    env.storage().persistent().extend_ttl(&key, bump, bump);
}

/// Unordered nonce per settler: one u128 word holds 128 nonces and a set bit is never cleared. Returns
/// false when the nonce was already spent. The write is rolled back with the rest of a failed call.
pub fn use_settler_nonce(env: &Env, settler: &Address, nonce: u64) -> bool {
    let key = DataKey::SettlerNonce(settler.clone(), nonce >> 7);
    let bit = 1u128 << (nonce & 0x7f);
    let word: u128 = env.storage().persistent().get(&key).unwrap_or(0);
    if word & bit != 0 {
        return false;
    }
    env.storage().persistent().set(&key, &(word | bit));
    let (_, bump) = ttl_window(env);
    env.storage().persistent().extend_ttl(&key, bump, bump);
    true
}

pub fn get_pending_delay(env: &Env) -> Option<PendingDelay> {
    env.storage().instance().get(&DataKey::PendingDelay)
}

pub fn set_pending_delay(env: &Env, pending: Option<PendingDelay>) {
    match pending {
        Some(p) => env.storage().instance().set(&DataKey::PendingDelay, &p),
        None => env.storage().instance().remove(&DataKey::PendingDelay),
    }
}
