use anchor_lang::prelude::*;

// ============================================================================
// Protocol Administration Events
// ============================================================================

#[event]
pub struct ProtocolInitialized {
    pub default_admin: Pubkey,
    pub token_config_authority: Pubkey,
    pub treasurer: Pubkey,
    pub pauser: Pubkey,
    pub cluster_id: [u8; 32],
    pub signature_domain_version: u8,
    pub default_admin_delay_seconds: u32,
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
pub struct Paused {
    pub by: Pubkey,
}

#[event]
pub struct Unpaused {
    pub by: Pubkey,
}

#[event]
pub struct TokenConfigAuthorityUpdated {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct TreasurerUpdated {
    pub old_treasurer: Pubkey,
    pub new_treasurer: Pubkey,
}

#[event]
pub struct PauserUpdated {
    pub old_pauser: Pubkey,
    pub new_pauser: Pubkey,
}

#[event]
pub struct DefaultAdminDelayUpdated {
    pub old_delay_seconds: u32,
    pub new_delay_seconds: u32,
}

// ============================================================================
// Token Configuration Events
// ============================================================================

#[event]
pub struct MintAllowed {
    pub mint: Pubkey,
}

#[event]
pub struct MintDisallowed {
    pub mint: Pubkey,
}

#[event]
pub struct MintFeesUpdated {
    pub mint: Pubkey,
    pub fee_percentage_6: u64,
    pub min_fee_6: u64,
    pub max_fee_6: u64,
}

#[event]
pub struct MintFeesCleared {
    pub mint: Pubkey,
}

// ============================================================================
// Delegation Events
// ============================================================================

#[event]
pub struct DelegateRevoked {
    pub authority: Pubkey,
    pub delegate: Pubkey,
    pub delegate_signer: Pubkey,
}

#[event]
pub struct DelegateRenounced {
    pub authority: Pubkey,
    pub delegate: Pubkey,
    pub delegate_signer: Pubkey,
}

// ============================================================================
// Escrow Lifecycle Events
// ============================================================================

#[event]
pub struct Deposited {
    pub deposit_hash: [u8; 32],
    pub depositor: Pubkey,
    pub reserver: Pubkey,
    pub releaser: Pubkey,
    pub amount: u64,
    pub fee_amount: u64,
    pub nonce: u64,
    pub issued_at: u64,
    pub deadline: u64,
}

#[event]
pub struct Reserved {
    pub deposit_hash: [u8; 32],
    pub recipient: Pubkey,
    pub quote_hash: [u8; 32],
    /// The amount the payer is actually charged, which reserve narrows
    /// `DepositInfo.amount` to. Emitted so an indexer can see the charge without replaying the
    /// reserve preimage, and so the ceiling-vs-charge gap is observable off-chain.
    pub source_amount: u64,
    /// Scaled from the deposit-time snapshot to `source_amount`, NOT recomputed from the live
    /// `MintFeeConfig`: the rate is frozen at deposit and only the amount it applies to narrows.
    /// `Reserve` carries neither the mint nor the fee config, so recomputation is not merely avoided
    /// here, it is structurally impossible. Supersedes the ceiling-based value the `Deposited` event
    /// carried. See `reserve` for why it is scaled, and for the min/max clamp that is deliberately
    /// not re-evaluated against the smaller amount.
    pub fee_amount: u64,
}

/// APPEND-ONLY. Anchor derives an event's discriminator from its NAME, not its layout, so a field
/// inserted mid-struct keeps the same discriminator and every un-upgraded positional consumer goes
/// on matching it and silently mis-decodes — reading `quote_hash` as `recipient` and the leading
/// bytes of the real pubkey as an amount. Nothing reverts and nothing logs.
///
/// New members therefore go at the END, where a stale reader simply stops before them. That is what
/// `Reserved` above does, and what `Released`/`Refunded` do here. atum-core's live scanner
/// (`core/block-scanner-orchestrator/plugins/solana/plugin.go`) is exactly such a positional reader:
/// its `readBytes` errors only on underrun, so trailing bytes are ignored by construction.
///
/// Renaming the event is the only safe way to make a layout change breaking, because that is the
/// one thing that moves the discriminator.
#[event]
pub struct Released {
    pub deposit_hash: [u8; 32],
    pub recipient: Pubkey,
    pub gross_amount: u64,
    pub intended_amount: u64,
    pub surplus_amount: u64,
    pub fee_amount: u64,
    pub net_amount: u64,
    /// Appended, not inserted — see the note above.
    pub quote_hash: [u8; 32],
}

/// APPEND-ONLY — see the note on `Released`.
#[event]
pub struct Refunded {
    pub deposit_hash: [u8; 32],
    pub depositor: Pubkey,
    pub amount: u64,
    /// Appended, not inserted — see the note above.
    pub quote_hash: [u8; 32],
}
