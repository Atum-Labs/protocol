// SPDX-License-Identifier: MIT
use anchor_lang::prelude::*;

/// Global protocol configuration PDA.
/// Seeds: ["protocol_config"]
///
/// v3 grew this struct ~119 -> 636 bytes by adding `enforce_settler_allowlist` and the pre-sized
/// `authorized_settlers` vec. `init_if_needed` only allocates space for a brand-new account and never
/// resizes an existing one, so an in-place program upgrade would leave the old config too small to
/// deserialize (breaking every instruction that loads it). There is intentionally NO `realloc` and NO
/// migration instruction: v3 ships as a fresh redeploy that re-runs `initialize_protocol` on a fresh
/// PDA (created at the full 636-byte size). See `docs/operations/deployment.md` for the redeploy
/// and re-initialization sequence.
#[account]
pub struct ProtocolConfig {
    /// The default admin with full role management authority.
    pub default_admin: Pubkey,
    /// Authority for pause/unpause operations.
    pub pauser: Pubkey,
    /// Whether protocol operations are paused.
    pub paused: bool,
    /// Delay in seconds for default admin transfer.
    pub default_admin_delay_seconds: u32,
    /// Pending new default admin (two-step transfer).
    pub pending_default_admin: Option<Pubkey>,
    /// Timestamp after which pending admin can accept transfer.
    pub pending_default_admin_accept_after_ts: Option<i64>,
    /// When true, `strict_fulfill` requires the settler to be in `authorized_settlers`.
    /// Ships false (dormant) so a fresh redeploy behaves exactly like the prior program; the admin
    /// flips it on after the allowlist is provisioned, and can flip it back off (instant rollback).
    pub enforce_settler_allowlist: bool,
    /// Settlers authorized to call `strict_fulfill` when enforcement is on. Bounded by
    /// MAX_AUTHORIZED_SETTLERS; the account is pre-sized for the maximum at init so no realloc is
    /// needed as entries are added/removed.
    pub authorized_settlers: Vec<Pubkey>,
}

impl ProtocolConfig {
    pub const SEED: &'static [u8] = b"protocol_config";

    /// Maximum number of authorized settlers held inline in the config.
    pub const MAX_AUTHORIZED_SETTLERS: usize = 16;

    // Size calculation:
    // discriminator: 8
    // default_admin: 32
    // pauser: 32
    // paused: 1
    // default_admin_delay_seconds: 4
    // pending_default_admin: 1 + 32 = 33
    // pending_default_admin_accept_after_ts: 1 + 8 = 9
    // enforce_settler_allowlist: 1
    // authorized_settlers: 4 (vec len prefix) + 32 * MAX_AUTHORIZED_SETTLERS
    // Total: 119 + 1 + 4 + 32 * 16 = 636
    pub const SIZE: usize =
        8 + 32 + 32 + 1 + 4 + 33 + 9 + 1 + 4 + 32 * Self::MAX_AUTHORIZED_SETTLERS;
}

/// Replay protection bucket for a specific settler.
#[account]
pub struct ReplayBucket {
    /// Two parity bitmaps; each parity has 256 bits (4x u64 words).
    /// Word 3 packs control metadata:
    /// - bit 63: initialization sentinel
    /// - bits 43..62: 20-bit epoch
    pub bitmaps: [[u64; 4]; 2],
}

impl ReplayBucket {
    // 8 (discriminator) + (4 * 8 bytes * 2 parities) = 72 bytes.
    pub const LEN: usize = 72;
}

/// One-time marker that a given settler has strictly fulfilled a given `quote_hash`. Seeded by the
/// quote hash and the settler, so a strict fulfillment is unique per (quote, settler) across any
/// nonce. The quote hash is public before the destination fulfill, so a marker seeded by the quote
/// hash alone could be set by any account to block the assigned settler; with the settler in the
/// seeds, another account only marks its own slot. Never closed. Markers written before the
/// settler joined the seeds sit at ["strict_fulfilled", quote_hash]; `strict_fulfill` refuses a quote
/// whose address there is not empty.
/// Seeds: ["strict_fulfilled", quote_hash, settler]
#[account]
pub struct StrictFulfillment {
    pub fulfilled: bool,
}

impl StrictFulfillment {
    // 8 (discriminator) + 1 (bool)
    pub const LEN: usize = 8 + 1;
}
