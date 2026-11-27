#![no_std]

//! Fulfillment proxy: the destination-chain half of an Atum payment. A settler pays the recipient
//! through this contract so offchain verification can bind the transfer to a quote hash.
//!
//! EVM `FulfillmentProxy.sol` is the source of truth for behaviour; the Solana program is the
//! structural model for admin state. Batch fulfilment (`fulfillMany`) is out of scope.

mod error;
mod events;
mod storage;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, token, Address, BytesN, Env};

pub use error::Error;
pub use events::*;
use storage::{
    extend_instance, get_config, get_pending_admin, get_pending_delay, is_settler,
    is_strictly_fulfilled, set_config, set_pending_admin, set_pending_delay, set_settler,
    set_strictly_fulfilled, use_settler_nonce, PendingAdmin, PendingDelay,
};

/// OpenZeppelin's `DEFAULT_ADMIN_DELAY_INCREASE_WAIT`: a delay increase takes effect after
/// min(new delay, 5 days), so a compromised admin cannot raise the delay and act under it at once.
pub const DELAY_INCREASE_WAIT_SECS: u64 = 5 * 24 * 60 * 60;

#[contract]
pub struct FulfillmentProxy;

fn now(env: &Env) -> u64 {
    env.ledger().timestamp()
}

fn require_not_paused(env: &Env) -> Result<(), Error> {
    if get_config(env).paused {
        return Err(Error::Paused);
    }
    Ok(())
}

/// (current delay, pending change). A pending change whose time has passed is the current delay; it
/// is applied lazily so nobody has to send a transaction for it to take effect. Strictly after, as
/// OpenZeppelin's `_isScheduleSet`/`_hasSchedulePassed` and the escrow.
fn delay_state(env: &Env) -> (u32, Option<PendingDelay>) {
    let current = get_config(env).delay_seconds;
    match get_pending_delay(env) {
        Some(p) if p.effective_at < now(env) => (p.new_delay, None),
        other => (current, other),
    }
}

/// Folds an elapsed pending change into storage before a new schedule is written or a transfer
/// reads the delay.
fn settle_delay(env: &Env) -> u32 {
    let (current, pending) = delay_state(env);
    let mut config = get_config(env);
    config.delay_seconds = current;
    set_config(env, &config);
    if pending.is_none() {
        set_pending_delay(env, None);
    }
    current
}

fn require_admin(env: &Env) {
    get_config(env).admin.require_auth();
}

/// Shared by `fulfill` and `strict_fulfill`. The zero-amount guard is unconditional: a zero-value
/// transfer is legal on SEP-41 tokens, and without it anyone could emit a genuine `Fulfilled` bound
/// to any quote hash for the price of fees, which an offchain matcher keyed on quote hash alone
/// could mistake for a real payment (Cantina F2 on EVM).
fn transfer_and_emit(
    env: &Env,
    settler: &Address,
    quote_hash: BytesN<32>,
    to: Address,
    token: Address,
    amount: i128,
) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::ZeroAmount);
    }
    // A direct transfer authorized by the settler's own auth entry, so no prior allowance to this
    // contract is needed (the EVM two-transaction approve + fulfill flow collapses into one).
    token::Client::new(env, &token).transfer(settler, &to, &amount);
    Fulfilled {
        quote_hash,
        settler: settler.clone(),
        to,
        token,
        amount,
        timestamp: now(env),
    }
    .publish(env);
    Ok(())
}

#[contractimpl]
impl FulfillmentProxy {
    /// Constructor runs atomically at deploy, so there is no window in which an attacker can
    /// initialize a deployed-but-unconfigured contract.
    pub fn __constructor(env: Env, default_admin: Address, pauser: Address, delay_seconds: u32) {
        ProxyInitialized {
            default_admin: default_admin.clone(),
            pauser: pauser.clone(),
            delay_seconds,
            enforce_settler_allowlist: false,
        }
        .publish(&env);
        set_config(
            &env,
            &storage::Config {
                admin: default_admin,
                pauser,
                paused: false,
                // Ships dormant (permissionless), like EVM and Solana. The strict marker is keyed on
                // the payment (quote hash, recipient, token, amount), so a caller cannot burn a
                // quote's marker with a different payment, but while dormant any caller can still
                // strict-fulfil the exact payment itself from its own funds, and so make the
                // awarded settler's identical call revert. Granting settlers and enforcing narrows
                // that to listed settlers. Enabling enforcement is a cutover step.
                enforce_settler_allowlist: false,
                delay_seconds,
            },
        );
    }

    /// Sends `amount` of `token` from `settler` to `to`, with no idempotency guarantee per quote hash,
    /// and reverts after `deadline` (unix seconds, inclusive), which the settler signs. `nonce` is
    /// chosen by the settler and spent once per settler: a failed attempt rolls its spend back, so a
    /// retry reuses the nonce, and whichever signed entry lands first consumes it and the other
    /// reverts with `NonceAlreadyUsed`.
    #[allow(clippy::too_many_arguments)]
    pub fn fulfill(
        env: Env,
        settler: Address,
        quote_hash: BytesN<32>,
        to: Address,
        token: Address,
        amount: i128,
        deadline: u64,
        nonce: u64,
    ) -> Result<(), Error> {
        extend_instance(&env);
        require_not_paused(&env)?;
        settler.require_auth();
        if now(&env) > deadline {
            return Err(Error::DeadlineExpired);
        }
        if !use_settler_nonce(&env, &settler, nonce) {
            return Err(Error::NonceAlreadyUsed);
        }
        transfer_and_emit(&env, &settler, quote_hash, to, token, amount)
    }

    /// Like `fulfill`, but reverts after `deadline` (unix seconds, inclusive) and on a second strict
    /// fulfilment of the same payment (quote hash, `to`, `token` and `amount` all equal), from any
    /// settler. Payments that differ in any of those four each have their own marker, so one quote
    /// hash can be strictly fulfilled by two different payments; the offchain verifier matches all four
    /// fields. `deadline` is supplied by the caller and
    /// is not bound to any quote onchain, so it bounds only what the settler chooses to pass. `nonce`
    /// is the settler's single-use value, shared with `fulfill`.
    #[allow(clippy::too_many_arguments)]
    pub fn strict_fulfill(
        env: Env,
        settler: Address,
        quote_hash: BytesN<32>,
        to: Address,
        token: Address,
        amount: i128,
        deadline: u64,
        nonce: u64,
    ) -> Result<(), Error> {
        extend_instance(&env);
        require_not_paused(&env)?;
        settler.require_auth();
        // Checked before the other guards so an unauthorized caller reverts uniformly, as on EVM
        // where the SETTLER_ROLE check runs first.
        if get_config(&env).enforce_settler_allowlist && !is_settler(&env, &settler) {
            return Err(Error::UnauthorizedSettler);
        }
        if now(&env) > deadline {
            return Err(Error::DeadlineExpired);
        }
        // Unconditional validity checks, not cutover flags: a zero hash is never a real quote, and a
        // zero amount would make the marker free to set.
        if quote_hash == BytesN::from_array(&env, &[0; 32]) {
            return Err(Error::QuoteHashCannotBeEmpty);
        }
        if amount <= 0 {
            return Err(Error::ZeroAmount);
        }
        if is_strictly_fulfilled(&env, &quote_hash, &to, &token, amount) {
            return Err(Error::AlreadyFulfilled);
        }
        if !use_settler_nonce(&env, &settler, nonce) {
            return Err(Error::NonceAlreadyUsed);
        }
        set_strictly_fulfilled(&env, &quote_hash, &to, &token, amount);
        transfer_and_emit(&env, &settler, quote_hash, to, token, amount)
    }

    /// Records that `settler` authorizes fulfilment of `quote_hash` under `authorization_hash`
    /// without moving tokens: the originator fulfils with the signed transfer the settler hands back.
    /// Emits only; writes no state and checks no deadline, matching EVM. Pause-gated like the rest.
    pub fn authorize_fulfillment(
        env: Env,
        settler: Address,
        quote_hash: BytesN<32>,
        authorization_hash: BytesN<32>,
    ) -> Result<(), Error> {
        extend_instance(&env);
        require_not_paused(&env)?;
        settler.require_auth();
        FulfillmentAuthorized {
            authorization_hash,
            quote_hash,
            settler,
        }
        .publish(&env);
        Ok(())
    }

    // ---- Settler allowlist (default admin) ----

    pub fn set_settler_allowlist_enforced(env: Env, enforced: bool) -> Result<(), Error> {
        extend_instance(&env);
        require_admin(&env);
        let mut config = get_config(&env);
        config.enforce_settler_allowlist = enforced;
        set_config(&env, &config);
        SettlerAllowlistEnforcementSet { enforced }.publish(&env);
        Ok(())
    }

    /// Idempotent; the event fires only on a real change so an indexer tracking the set never sees
    /// a phantom entry (parity with OZ `RoleGranted`).
    pub fn add_authorized_settler(env: Env, settler: Address) -> Result<(), Error> {
        extend_instance(&env);
        require_admin(&env);
        if !is_settler(&env, &settler) {
            set_settler(&env, &settler, true);
            AuthorizedSettlerAdded { settler }.publish(&env);
        }
        Ok(())
    }

    pub fn remove_authorized_settler(env: Env, settler: Address) -> Result<(), Error> {
        extend_instance(&env);
        require_admin(&env);
        if is_settler(&env, &settler) {
            set_settler(&env, &settler, false);
            AuthorizedSettlerRemoved { settler }.publish(&env);
        }
        Ok(())
    }

    // ---- Pause ----

    /// Reverts with `Paused` when already paused, as OZ `whenNotPaused` and the escrow do, so a
    /// no-op never re-emits an event.
    pub fn pause(env: Env) -> Result<(), Error> {
        extend_instance(&env);
        let mut config = get_config(&env);
        config.pauser.require_auth();
        if config.paused {
            return Err(Error::Paused);
        }
        config.paused = true;
        set_config(&env, &config);
        ProxyPaused { by: config.pauser }.publish(&env);
        Ok(())
    }

    /// Reverts with `NotPaused` when not paused (OZ `whenPaused`).
    pub fn unpause(env: Env) -> Result<(), Error> {
        extend_instance(&env);
        let mut config = get_config(&env);
        config.pauser.require_auth();
        if !config.paused {
            return Err(Error::NotPaused);
        }
        config.paused = false;
        set_config(&env, &config);
        ProxyUnpaused { by: config.pauser }.publish(&env);
        Ok(())
    }

    pub fn set_pauser(env: Env, new_pauser: Address) -> Result<(), Error> {
        extend_instance(&env);
        require_admin(&env);
        let mut config = get_config(&env);
        let old_pauser = core::mem::replace(&mut config.pauser, new_pauser.clone());
        set_config(&env, &config);
        PauserUpdated {
            old_pauser,
            new_pauser,
        }
        .publish(&env);
        Ok(())
    }

    // ---- Default admin: delayed two-step transfer ----

    pub fn begin_default_admin_transfer(env: Env, new_admin: Address) -> Result<(), Error> {
        extend_instance(&env);
        require_admin(&env);
        let delay_seconds = settle_delay(&env);
        let accept_after = now(&env)
            .checked_add(u64::from(delay_seconds))
            .ok_or(Error::TimestampOverflow)?;
        // Replaces any pending transfer, as OZ AccessControlDefaultAdminRules does, and says so.
        if get_pending_admin(&env).is_some() {
            DefaultAdminTransferCanceled {
                admin: get_config(&env).admin,
            }
            .publish(&env);
        }
        set_pending_admin(
            &env,
            Some(PendingAdmin {
                admin: new_admin.clone(),
                accept_after,
            }),
        );
        DefaultAdminTransferScheduled {
            new_admin,
            accept_after,
        }
        .publish(&env);
        Ok(())
    }

    pub fn cancel_default_admin_transfer(env: Env) -> Result<(), Error> {
        extend_instance(&env);
        require_admin(&env);
        if get_pending_admin(&env).is_none() {
            return Err(Error::NoPendingAdminTransfer);
        }
        set_pending_admin(&env, None);
        DefaultAdminTransferCanceled {
            admin: get_config(&env).admin,
        }
        .publish(&env);
        Ok(())
    }

    /// Only the pending admin can accept, which proves the new key is live before the old one is
    /// dropped.
    pub fn accept_default_admin_transfer(env: Env) -> Result<(), Error> {
        extend_instance(&env);
        let pending = get_pending_admin(&env).ok_or(Error::NoPendingAdminTransfer)?;
        pending.admin.require_auth();
        // Strictly after, as OpenZeppelin's `_hasSchedulePassed` and the escrow.
        if now(&env) <= pending.accept_after {
            return Err(Error::AdminTransferNotReady);
        }
        let mut config = get_config(&env);
        let old_admin = core::mem::replace(&mut config.admin, pending.admin.clone());
        set_config(&env, &config);
        set_pending_admin(&env, None);
        DefaultAdminTransferred {
            old_admin,
            new_admin: pending.admin,
        }
        .publish(&env);
        Ok(())
    }

    /// Schedules a new transfer delay, as OZ `changeDefaultAdminDelay` and the escrow: an increase
    /// takes effect after min(new, 5 days), a decrease after the difference between the current and
    /// new delay. A pending change is replaced. Until it takes effect, transfers use the old delay,
    /// so a compromised admin cannot zero the delay and begin + accept in one ledger.
    pub fn change_default_admin_delay(env: Env, new_delay_seconds: u32) -> Result<(), Error> {
        extend_instance(&env);
        require_admin(&env);
        let current = settle_delay(&env);
        let wait = if new_delay_seconds > current {
            u64::from(new_delay_seconds).min(DELAY_INCREASE_WAIT_SECS)
        } else {
            u64::from(current - new_delay_seconds)
        };
        let effective_at = now(&env)
            .checked_add(wait)
            .ok_or(Error::TimestampOverflow)?;
        // settle_delay dropped an elapsed change, so a stored one is still pending and is replaced
        if get_pending_delay(&env).is_some() {
            AdminDelayChangeCanceled {
                admin: get_config(&env).admin,
            }
            .publish(&env);
        }
        set_pending_delay(
            &env,
            Some(PendingDelay {
                new_delay: new_delay_seconds,
                effective_at,
            }),
        );
        AdminDelayChangeScheduled {
            new_delay: new_delay_seconds,
            effective_at,
        }
        .publish(&env);
        Ok(())
    }

    /// Cancels a scheduled delay change (OZ `rollbackDefaultAdminDelay`).
    pub fn rollback_default_admin_delay(env: Env) -> Result<(), Error> {
        extend_instance(&env);
        require_admin(&env);
        settle_delay(&env);
        if get_pending_delay(&env).is_none() {
            return Err(Error::NoPendingDelayChange);
        }
        set_pending_delay(&env, None);
        AdminDelayChangeCanceled {
            admin: get_config(&env).admin,
        }
        .publish(&env);
        Ok(())
    }

    // ---- Views ----

    pub fn default_admin(env: Env) -> Address {
        get_config(&env).admin
    }

    pub fn pauser(env: Env) -> Address {
        get_config(&env).pauser
    }

    pub fn is_paused(env: Env) -> bool {
        get_config(&env).paused
    }

    pub fn settler_allowlist_enforced(env: Env) -> bool {
        get_config(&env).enforce_settler_allowlist
    }

    pub fn is_authorized_settler(env: Env, settler: Address) -> bool {
        is_settler(&env, &settler)
    }

    /// Whether this exact payment (quote hash, recipient, token, amount) was strictly fulfilled.
    pub fn is_strictly_fulfilled(
        env: Env,
        quote_hash: BytesN<32>,
        to: Address,
        token: Address,
        amount: i128,
    ) -> bool {
        is_strictly_fulfilled(&env, &quote_hash, &to, &token, amount)
    }

    /// The delay in force now, counting a scheduled change that has already taken effect.
    pub fn default_admin_delay(env: Env) -> u32 {
        delay_state(&env).0
    }

    pub fn pending_default_admin_delay(env: Env) -> Option<PendingDelay> {
        delay_state(&env).1
    }

    pub fn pending_default_admin(env: Env) -> Option<PendingAdmin> {
        get_pending_admin(&env)
    }
}
