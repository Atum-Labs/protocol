use anchor_lang::prelude::*;

#[event]
pub struct ProtocolInitialized {
    pub default_admin: Pubkey,
    pub pauser: Pubkey,
    pub default_admin_delay_seconds: u32,
}

#[event]
pub struct Paused {
    pub by: Pubkey,
}

#[event]
pub struct Unpaused {
    pub by: Pubkey,
}

#[event]
pub struct PauserUpdated {
    pub old_pauser: Pubkey,
    pub new_pauser: Pubkey,
}

#[event]
pub struct DefaultAdminTransferBegun {
    pub current_admin: Pubkey,
    pub pending_admin: Pubkey,
    pub accept_after_ts: i64,
}

#[event]
pub struct DefaultAdminTransferred {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct DefaultAdminDelayUpdated {
    pub old_delay_seconds: u32,
    pub new_delay_seconds: u32,
}

/// Emitted when the admin toggles settler-allowlist enforcement on `strict_fulfill`.
#[event]
pub struct SettlerAllowlistEnforcementSet {
    pub enforced: bool,
}

/// Emitted when the admin adds a settler to the `strict_fulfill` allowlist.
#[event]
pub struct AuthorizedSettlerAdded {
    pub settler: Pubkey,
}

/// Emitted when the admin removes a settler from the `strict_fulfill` allowlist.
#[event]
pub struct AuthorizedSettlerRemoved {
    pub settler: Pubkey,
}

#[event]
pub struct Fulfilled {
    pub quote_hash: [u8; 32],
    pub to: Pubkey,
    pub token: Pubkey,
    pub amount: u64,
}

#[event]
pub struct StrictFulfilled {
    pub quote_hash: [u8; 32],
    pub to: Pubkey,
    pub token: Pubkey,
    pub amount: u64,
    pub nonce: u64,
    pub issued_at: u64,
    pub deadline: u64,
}
