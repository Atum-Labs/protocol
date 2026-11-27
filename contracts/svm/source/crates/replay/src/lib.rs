// SPDX-License-Identifier: MIT
pub mod check;
pub mod errors;

pub use check::{check_replay, is_used};
pub use errors::ReplayError;

/// How long a signed authorization stays valid after its `issued_at`.
pub const REPLAY_HORIZON_SECS: u64 = 128;

/// Length of one replay time slice is `1 << REPLAY_SLICE_SHIFT` seconds. Two bitmaps alternate by
/// slice parity, and the slice length has to be at least twice `REPLAY_HORIZON_SECS`.
///
/// A nonce used by one authorization has to stay recorded until every authorization that was
/// signed while the first was still valid has itself expired: up to `2 * REPLAY_HORIZON_SECS` after
/// the first one was issued. With slices as short as the horizon that span covers three slices,
/// and two bitmaps can only hold two, so a rotation could erase the record while a later
/// authorization with the same nonce was still valid. With slices at least twice the horizon the
/// span fits in two, which is what two bitmaps hold.
pub const REPLAY_SLICE_SHIFT: u32 = 8;

/// Length of one replay time slice in seconds.
pub const REPLAY_SLICE_SECS: u64 = 1 << REPLAY_SLICE_SHIFT;

const _: () = assert!(REPLAY_SLICE_SECS >= 2 * REPLAY_HORIZON_SECS);

/// Number of valid nonce slots in each parity bitmap.
pub const REPLAY_SLOTS: usize = 235;

/// Derive replay bucket selector from nonce bytes [4..8] (little-endian).
/// Bits 8..31 are intentionally ignored by slot mapping.
pub fn derive_replay_bucket_selector(nonce: u64) -> [u8; 4] {
    let bytes = nonce.to_le_bytes();
    [bytes[4], bytes[5], bytes[6], bytes[7]]
}

/// Validate and decode a full-width nonce slot into a replay-slot index.
/// Returns `None` if the slot is out of range (>= 235).
#[inline(always)]
pub fn decode_replay_slot(slot: u16) -> Option<u8> {
    if slot < REPLAY_SLOTS as u16 {
        Some(slot as u8)
    } else {
        None
    }
}
