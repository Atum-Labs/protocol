// SPDX-License-Identifier: MIT

//! Roles, the delayed default-admin transfer and pause: the AccessControlDefaultAdminRules and
//! Pausable behaviour of the EVM escrow, minus `renounceRole`/`grantRole` of the admin role itself
//! (the admin only moves through the two-step transfer).

use soroban_sdk::{Address, Env};

use crate::errors::Error;
use crate::events;
use crate::storage::{bump, get_persistent, DataKey};
use crate::types::{PendingAdmin, PendingDelay, Role};

/// OpenZeppelin's `DEFAULT_ADMIN_DELAY_INCREASE_WAIT`: a delay increase takes effect after
/// min(new delay, 5 days), so a compromised admin cannot raise the delay and act under it at once.
pub const DELAY_INCREASE_WAIT_SECS: u64 = 5 * 24 * 60 * 60;

pub fn default_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::DefaultAdmin)
        .expect("initialised in the constructor")
}

pub fn require_default_admin(env: &Env) -> Address {
    let admin = default_admin(env);
    admin.require_auth();
    admin
}

pub fn has_role(env: &Env, role: Role, account: &Address) -> bool {
    let key = DataKey::Role(role, account.clone());
    get_persistent::<bool>(env, &key).unwrap_or(false)
}

/// `caller` authorises the call and must hold `role`. Soroban has no `msg.sender`, so every
/// role-gated entry point takes the acting account as an argument.
pub fn require_role(env: &Env, role: Role, caller: &Address) -> Result<(), Error> {
    caller.require_auth();
    if has_role(env, role, caller) {
        Ok(())
    } else {
        Err(Error::MissingRole)
    }
}

pub fn grant_role(env: &Env, role: Role, account: &Address) {
    let key = DataKey::Role(role, account.clone());
    env.storage().persistent().set(&key, &true);
    bump(env, &key);
}

pub fn revoke_role(env: &Env, role: Role, account: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::Role(role, account.clone()));
}

// Pause

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn require_not_paused(env: &Env) -> Result<(), Error> {
    if is_paused(env) {
        Err(Error::Paused)
    } else {
        Ok(())
    }
}

pub fn set_paused(env: &Env, paused: bool, by: &Address) -> Result<(), Error> {
    if is_paused(env) == paused {
        return Err(if paused {
            Error::Paused
        } else {
            Error::NotPaused
        });
    }
    env.storage().instance().set(&DataKey::Paused, &paused);
    if paused {
        events::Paused { by: by.clone() }.publish(env);
    } else {
        events::Unpaused { by: by.clone() }.publish(env);
    }
    Ok(())
}

// Delay

/// (current delay, pending change). A pending change whose time has passed is the current delay;
/// it is applied lazily so nobody has to send a transaction for it to take effect.
pub fn delay_state(env: &Env) -> (u32, Option<PendingDelay>) {
    let current: u32 = env
        .storage()
        .instance()
        .get(&DataKey::AdminDelay)
        .unwrap_or(0);
    let pending: Option<PendingDelay> = env.storage().instance().get(&DataKey::PendingDelay);
    match pending {
        Some(p) if p.effective_at < env.ledger().timestamp() => (p.new_delay, None),
        other => (current, other),
    }
}

/// Folds an elapsed pending change into storage before a new schedule is written.
fn settle_delay(env: &Env) -> u32 {
    let (current, pending) = delay_state(env);
    env.storage().instance().set(&DataKey::AdminDelay, &current);
    if pending.is_none() {
        env.storage().instance().remove(&DataKey::PendingDelay);
    }
    current
}

pub fn change_delay(env: &Env, new_delay: u32) -> Result<(), Error> {
    let current = settle_delay(env);
    let wait = if new_delay > current {
        (new_delay as u64).min(DELAY_INCREASE_WAIT_SECS)
    } else {
        (current - new_delay) as u64
    };
    let effective_at = env
        .ledger()
        .timestamp()
        .checked_add(wait)
        .ok_or(Error::TimestampOverflow)?;
    // settle_delay dropped an elapsed change, so a stored one is still pending and is replaced
    if env.storage().instance().has(&DataKey::PendingDelay) {
        events::AdminDelayChangeCanceled {
            admin: default_admin(env),
        }
        .publish(env);
    }
    env.storage().instance().set(
        &DataKey::PendingDelay,
        &PendingDelay {
            new_delay,
            effective_at,
        },
    );
    events::AdminDelayChangeScheduled {
        new_delay,
        effective_at,
    }
    .publish(env);
    Ok(())
}

pub fn rollback_delay(env: &Env) -> Result<(), Error> {
    settle_delay(env);
    if !env.storage().instance().has(&DataKey::PendingDelay) {
        return Err(Error::NoPendingDelayChange);
    }
    env.storage().instance().remove(&DataKey::PendingDelay);
    events::AdminDelayChangeCanceled {
        admin: default_admin(env),
    }
    .publish(env);
    Ok(())
}

// Admin transfer

pub fn begin_transfer(env: &Env, new_admin: Address) -> Result<(), Error> {
    let delay = settle_delay(env);
    let accept_after = env
        .ledger()
        .timestamp()
        .checked_add(u64::from(delay))
        .ok_or(Error::TimestampOverflow)?;
    // A stored pending transfer is replaced: say so, as an explicit cancel does
    if env.storage().instance().has(&DataKey::PendingAdmin) {
        events::DefaultAdminTransferCanceled {
            admin: default_admin(env),
        }
        .publish(env);
    }
    env.storage().instance().set(
        &DataKey::PendingAdmin,
        &PendingAdmin {
            new_admin: new_admin.clone(),
            accept_after,
        },
    );
    events::DefaultAdminTransferScheduled {
        new_admin,
        accept_after,
    }
    .publish(env);
    Ok(())
}

pub fn cancel_transfer(env: &Env) -> Result<(), Error> {
    if !env.storage().instance().has(&DataKey::PendingAdmin) {
        return Err(Error::NoPendingAdminTransfer);
    }
    env.storage().instance().remove(&DataKey::PendingAdmin);
    events::DefaultAdminTransferCanceled {
        admin: default_admin(env),
    }
    .publish(env);
    Ok(())
}

pub fn accept_transfer(env: &Env) -> Result<(), Error> {
    let pending: PendingAdmin = env
        .storage()
        .instance()
        .get(&DataKey::PendingAdmin)
        .ok_or(Error::NoPendingAdminTransfer)?;
    pending.new_admin.require_auth();
    // Strictly after, as OpenZeppelin's `_hasSchedulePassed`
    if pending.accept_after >= env.ledger().timestamp() {
        return Err(Error::AdminTransferNotReady);
    }
    let old = default_admin(env);
    env.storage()
        .instance()
        .set(&DataKey::DefaultAdmin, &pending.new_admin);
    env.storage().instance().remove(&DataKey::PendingAdmin);
    events::DefaultAdminTransferred {
        old_admin: old,
        new_admin: pending.new_admin,
    }
    .publish(env);
    Ok(())
}
