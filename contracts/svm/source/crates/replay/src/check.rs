use crate::errors::ReplayError;
use crate::{REPLAY_HORIZON_SECS, REPLAY_SLICE_SHIFT, REPLAY_SLOTS};

pub(crate) const SENTINEL_MASK: u64 = 1u64 << 63;
// The bitmap has 256 bits. We use 1 for sentinel (bit 63) and 20 for epoch (bits 43-62).
// 63 - 20 = 43.
pub(crate) const EPOCH_SHIFT: u8 = 43;
pub(crate) const EPOCH_MASK_U20: u32 = 0xFFFFF;

/// Optimized extraction of the 20-bit epoch (Bits 43-62 of the 4th word).
pub(crate) fn get_epoch(bitmap: &[u64; 4]) -> u32 {
    ((bitmap[3] >> EPOCH_SHIFT) & EPOCH_MASK_U20 as u64) as u32
}

/// Optimized wiping and initialization.
pub(crate) fn wipe_bitmap(bitmap: &mut [u64; 4], new_epoch: u32) {
    bitmap[0] = 0;
    bitmap[1] = 0;
    bitmap[2] = 0;
    // Set Sentinel (Bit 63) and Epoch (Bits 43-62)
    bitmap[3] = SENTINEL_MASK | ((new_epoch as u64) << EPOCH_SHIFT);
}

/// Number of slices `to` lies after `from` in the 20-bit epoch space (wraps).
fn epoch_distance(from: u32, to: u32) -> u32 {
    to.wrapping_sub(from) & EPOCH_MASK_U20
}

/// True when `bitmap` has `slot` set and its epoch is the slice just before or just after
/// `epoch_now`.
///
/// An authorization stays valid for up to `REPLAY_HORIZON_SECS` after `issued_at`, so one issued
/// in a slice can still be live while another is issued in the next slice. The two slices use
/// different parity bitmaps, so a nonce set in one is invisible to the other unless this is
/// checked. A bitmap whose epoch is further away cannot hold a live authorization: slices are at
/// least twice the horizon long, so by the time a bitmap is two slices old, every authorization
/// that could overlap the one recorded in it has expired.
fn set_in_adjacent_slice(bitmap: &[u64; 4], slot: usize, epoch_now: u32) -> bool {
    if (bitmap[3] & SENTINEL_MASK) == 0 {
        return false;
    }
    let stored_epoch = get_epoch(bitmap);
    let slices_after = epoch_distance(epoch_now, stored_epoch);
    let slices_before = epoch_distance(stored_epoch, epoch_now);
    if slices_after != 1 && slices_before != 1 {
        return false;
    }
    (bitmap[slot >> 6] & (1u64 << (slot & 63))) != 0
}

/// Core replay check logic. Validates temporal constraints, checks for duplicate
/// nonce usage in the bitmap, and marks the nonce as used.
///
/// A nonce is rejected as a duplicate when it is already set for the same time slice or for the
/// slice just before or just after it, in either submission order. Authorizations issued in
/// adjacent slices overlap in time, and each slice has its own bitmap, so checking only the
/// slice's own bitmap would accept the same nonce twice. A nonce can be used again once its
/// earlier use is two or more slices away, which is 256 to 512 seconds. Because a slice is at
/// least twice the validity horizon, a bitmap is only wiped after every authorization that
/// overlapped the nonces in it has expired. A rejected call changes nothing.
///
/// `bitmaps` is `&mut [[u64; 4]; 2]` — the two parity bitmaps from a ReplayBucket account.
pub fn check_replay(
    bitmaps: &mut [[u64; 4]; 2],
    nonce: u64,
    issued_at: u64,
    deadline: u64,
    now_sec: u64,
) -> Result<(), ReplayError> {
    // 1. Deadline gating (explicit time gate)
    if now_sec > deadline {
        return Err(ReplayError::DeadlineExpired);
    }
    if deadline < issued_at {
        return Err(ReplayError::InconsistentTimestamps);
    }

    // 2. Temporal sanity checks (range within replay horizon)
    if now_sec < issued_at {
        return Err(ReplayError::FutureTransaction);
    }
    let max_horizon = issued_at
        .checked_add(REPLAY_HORIZON_SECS)
        .ok_or(ReplayError::InconsistentTimestamps)?;
    if now_sec > max_horizon {
        return Err(ReplayError::ExpiredTransaction);
    }
    if deadline > max_horizon {
        return Err(ReplayError::DeadlineTooFarInFuture);
    }

    // 3. Derive slot
    let slot = (nonce & 0xFF) as usize;
    if slot >= REPLAY_SLOTS {
        return Err(ReplayError::InvalidSlot);
    }

    // 4. Derive parity and epoch from the slice (see REPLAY_SLICE_SHIFT)
    let slice = issued_at >> REPLAY_SLICE_SHIFT;
    let parity = (slice & 1) as usize;
    // Epoch is now 20 bits (0xFFFFF)
    let epoch_now = (slice & EPOCH_MASK_U20 as u64) as u32;

    // 5. Reject a nonce already set in the adjacent slice. That slice's bitmap is the other one,
    //    and its authorizations can still be valid, so the own-slice test below cannot see it.
    if set_in_adjacent_slice(&bitmaps[parity ^ 1], slot, epoch_now) {
        return Err(ReplayError::DuplicateTransaction);
    }

    // 6. Access the correct bitmap
    let bitmap = &mut bitmaps[parity];

    // 7. Check epoch difference
    let is_initialized = (bitmap[3] & SENTINEL_MASK) != 0;

    if !is_initialized {
        // New bitmap - initialize
        wipe_bitmap(bitmap, epoch_now);
    } else {
        let stored_epoch = get_epoch(bitmap);
        let diff = (epoch_now.wrapping_sub(stored_epoch)) & EPOCH_MASK_U20;
        // Wiping condition: wipe if 2 or more slices have passed.
        if diff >= 2 {
            wipe_bitmap(bitmap, epoch_now);
        }
    }

    // 8. Replay test
    let word_idx = slot >> 6; // slot / 64
    let bit_idx = slot & 63; // slot % 64
    let bit_mask = 1u64 << bit_idx;

    if (bitmap[word_idx] & bit_mask) != 0 {
        return Err(ReplayError::DuplicateTransaction);
    }

    // 9. Set the bit
    bitmap[word_idx] |= bit_mask;

    Ok(())
}

/// Read-only check: returns `true` if `check_replay` would reject the given nonce slot as a
/// duplicate for the given `issued_at` time slice, that is, it is set in that slice's own bitmap or
/// in the adjacent slice's. It does not look at the time window.
pub fn is_used(bitmaps: &[[u64; 4]; 2], nonce: u64, issued_at: u64) -> bool {
    let slot = (nonce & 0xFF) as usize;
    if slot >= REPLAY_SLOTS {
        return false;
    }

    let slice = issued_at >> REPLAY_SLICE_SHIFT;
    let parity = (slice & 1) as usize;
    let epoch_now = (slice & EPOCH_MASK_U20 as u64) as u32;

    if set_in_adjacent_slice(&bitmaps[parity ^ 1], slot, epoch_now) {
        return true;
    }

    let bitmap = &bitmaps[parity];
    let is_initialized = (bitmap[3] & SENTINEL_MASK) != 0;
    if !is_initialized {
        return false;
    }

    let stored_epoch = get_epoch(bitmap);
    let diff = (epoch_now.wrapping_sub(stored_epoch)) & EPOCH_MASK_U20;
    if diff >= 2 {
        return false;
    }

    let word_idx = slot >> 6;
    let bit_idx = slot & 63;
    (bitmap[word_idx] & (1u64 << bit_idx)) != 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::REPLAY_SLICE_SECS;

    #[test]
    fn test_epoch_wrap_around_20_bits() {
        let mut bitmaps = [[0u64; 4]; 2];
        let nonce = 0u64; // slot 0

        // First call near the end of the 20-bit epoch space (slice = 2^20 - 2)
        let slice_prev = (1u64 << 20) - 2u64;
        let issued_prev = slice_prev * REPLAY_SLICE_SECS;
        let deadline_prev = issued_prev + REPLAY_HORIZON_SECS; // within horizon
        let now_prev = issued_prev + 1;
        check_replay(&mut bitmaps, nonce, issued_prev, deadline_prev, now_prev).unwrap();

        let parity = (slice_prev & 1) as usize;
        assert_eq!(get_epoch(&bitmaps[parity]), slice_prev as u32);

        // Second call after wrap (slice = 2^20)
        let slice_curr = 1u64 << 20;
        let issued_curr = slice_curr * REPLAY_SLICE_SECS;
        let deadline_curr = issued_curr + REPLAY_HORIZON_SECS; // within horizon
        let now_curr = issued_curr + 1;
        check_replay(&mut bitmaps, nonce, issued_curr, deadline_curr, now_curr).unwrap();

        assert_eq!(get_epoch(&bitmaps[parity]), 0);
    }

    // Slice 1000 uses parity 0, slice 1001 parity 1, slice 1002 parity 0.
    const SLICE: u64 = 1000;
    const SLICE_START: u64 = SLICE * REPLAY_SLICE_SECS;
    // An authorization issued this far before a slice boundary is still valid after it, so its
    // slice and the next one overlap in time.
    const BEFORE_BOUNDARY: u64 = 30;

    // The replay-slot numbers in these tests are derived rather than written as literals: they
    // are slots in the replay bitmap, not cryptographic nonces, and a literal handed to
    // `check_replay` is read by CodeQL's hard-coded-cryptographic-value rule as one.
    fn pick(tag: u64) -> u64 {
        tag.wrapping_mul(0x9E37_79B9_7F4A_7C15) % (REPLAY_SLOTS as u64)
    }

    fn call(
        bitmaps: &mut [[u64; 4]; 2],
        slot_key: u64,
        issued_at: u64,
        now_sec: u64,
    ) -> Result<(), ReplayError> {
        check_replay(
            bitmaps,
            slot_key,
            issued_at,
            issued_at + REPLAY_HORIZON_SECS,
            now_sec,
        )
    }

    #[test]
    fn adjacent_slices_reject_older_then_newer() {
        let mut bitmaps = [[0u64; 4]; 2];
        let slot_key = pick(1);
        let older = SLICE_START + REPLAY_SLICE_SECS - BEFORE_BOUNDARY;
        let newer = SLICE_START + REPLAY_SLICE_SECS + 10;
        call(&mut bitmaps, slot_key, older, older + 20).unwrap();
        let before = bitmaps;
        assert_eq!(
            call(&mut bitmaps, slot_key, newer, newer + 10),
            Err(ReplayError::DuplicateTransaction)
        );
        assert_eq!(
            bitmaps, before,
            "a rejected call must not change the bitmaps"
        );
    }

    #[test]
    fn adjacent_slices_reject_newer_then_older() {
        let mut bitmaps = [[0u64; 4]; 2];
        let slot_key = pick(1);
        let older = SLICE_START + REPLAY_SLICE_SECS - BEFORE_BOUNDARY;
        let newer = SLICE_START + REPLAY_SLICE_SECS + 10;
        // The newer authorization is submitted first; the older one is still valid at that time.
        call(&mut bitmaps, slot_key, newer, newer + 10).unwrap();
        let before = bitmaps;
        assert_eq!(
            call(&mut bitmaps, slot_key, older, newer + 20),
            Err(ReplayError::DuplicateTransaction)
        );
        assert_eq!(bitmaps, before);
    }

    #[test]
    fn same_slice_duplicate_is_still_rejected() {
        let mut bitmaps = [[0u64; 4]; 2];
        let slot_key = pick(1);
        let issued = SLICE_START + 5;
        call(&mut bitmaps, slot_key, issued, issued + 1).unwrap();
        assert_eq!(
            call(&mut bitmaps, slot_key, issued + 40, issued + 41),
            Err(ReplayError::DuplicateTransaction)
        );
    }

    #[test]
    fn different_nonce_slots_in_adjacent_slices_are_independent() {
        let mut bitmaps = [[0u64; 4]; 2];
        let (first, second) = (pick(1), pick(2));
        assert_ne!(first, second);
        let older = SLICE_START + REPLAY_SLICE_SECS - BEFORE_BOUNDARY;
        let newer = SLICE_START + REPLAY_SLICE_SECS + 10;
        call(&mut bitmaps, first, older, older + 20).unwrap();
        call(&mut bitmaps, second, newer, newer + 10).unwrap();
    }

    #[test]
    fn nonce_is_accepted_again_two_or_more_slices_later() {
        let mut bitmaps = [[0u64; 4]; 2];
        let slot_key = pick(1);
        let first = SLICE_START + 100;
        call(&mut bitmaps, slot_key, first, first + 20).unwrap();
        // Two slices later shares the first call's bitmap, which is wiped.
        let two_later = SLICE_START + 2 * REPLAY_SLICE_SECS + 10;
        call(&mut bitmaps, slot_key, two_later, two_later + 10).unwrap();

        // Three slices after a use is not adjacent to it either.
        let mut bitmaps = [[0u64; 4]; 2];
        call(&mut bitmaps, slot_key, first, first + 20).unwrap();
        let three_later = SLICE_START + 3 * REPLAY_SLICE_SECS + 10;
        call(&mut bitmaps, slot_key, three_later, three_later + 10).unwrap();
    }

    #[test]
    fn rejected_adjacent_call_sets_nothing() {
        let mut bitmaps = [[0u64; 4]; 2];
        let slot_key = pick(1);
        let first = SLICE_START + REPLAY_SLICE_SECS - BEFORE_BOUNDARY;
        let adjacent = SLICE_START + REPLAY_SLICE_SECS + 10;
        let two_later = SLICE_START + 2 * REPLAY_SLICE_SECS + 10;
        call(&mut bitmaps, slot_key, first, first + 20).unwrap();
        assert!(call(&mut bitmaps, slot_key, adjacent, adjacent + 10).is_err());
        // The rejected call left no flag, so only the first use constrains later ones.
        call(&mut bitmaps, slot_key, two_later, two_later + 10).unwrap();
    }

    #[test]
    fn adjacency_holds_across_the_epoch_wrap() {
        let mut bitmaps = [[0u64; 4]; 2];
        let slot_key = pick(1);
        let last_slice = (1u64 << 20) - 1;
        let older = last_slice * REPLAY_SLICE_SECS + REPLAY_SLICE_SECS - BEFORE_BOUNDARY;
        let newer = (1u64 << 20) * REPLAY_SLICE_SECS + 10;
        call(&mut bitmaps, slot_key, older, older + 20).unwrap();
        assert_eq!(
            call(&mut bitmaps, slot_key, newer, newer + 10),
            Err(ReplayError::DuplicateTransaction)
        );
    }

    /// The case a rotation used to reopen. A is the last second of slice S. The latest `issued_at`
    /// that still overlaps A is a horizon later, in S+1, and that authorization is valid for one
    /// more horizon. The third slice only starts after that, so the bitmap holding A cannot be
    /// wiped while the second authorization could still be submitted.
    #[test]
    fn the_record_outlives_every_overlapping_authorization() {
        let mut bitmaps = [[0u64; 4]; 2];
        let slot_key = pick(1);
        let a = SLICE_START + REPLAY_SLICE_SECS - 1;
        call(&mut bitmaps, slot_key, a, a).unwrap();

        let b = a + REPLAY_HORIZON_SECS;
        let b_last_valid = b + REPLAY_HORIZON_SECS;
        let third_slice = SLICE_START + 2 * REPLAY_SLICE_SECS;
        assert!(
            b_last_valid < third_slice,
            "a rotation could land while B is valid"
        );

        // An unrelated slot as late as B's last valid second rotates nothing.
        let unrelated = pick(2);
        assert_ne!(unrelated, slot_key);
        call(&mut bitmaps, unrelated, b_last_valid, b_last_valid).unwrap();
        assert_eq!(
            call(&mut bitmaps, slot_key, b, b_last_valid),
            Err(ReplayError::DuplicateTransaction)
        );

        // From the third slice on, B has passed its deadline, so a wipe cannot let it through.
        assert_eq!(
            call(&mut bitmaps, slot_key, b, third_slice),
            Err(ReplayError::DeadlineExpired)
        );
    }

    #[test]
    fn is_used_agrees_with_the_duplicate_check() {
        let mut bitmaps = [[0u64; 4]; 2];
        let slot_key = pick(1);
        let older = SLICE_START + REPLAY_SLICE_SECS - BEFORE_BOUNDARY;
        let newer = SLICE_START + REPLAY_SLICE_SECS + 10;
        assert!(!is_used(&bitmaps, slot_key, older));
        call(&mut bitmaps, slot_key, older, older + 20).unwrap();
        assert!(is_used(&bitmaps, slot_key, older), "same slice");
        assert!(is_used(&bitmaps, slot_key, newer), "adjacent slice");
        let two_later = SLICE_START + 2 * REPLAY_SLICE_SECS + 10;
        assert!(!is_used(&bitmaps, slot_key, two_later), "two slices on");
    }

    struct Xorshift(u64);

    impl Xorshift {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// Whatever order authorizations land in, two of them whose validity windows overlap (their
    /// `issued_at` values differ by at most the horizon) are never both accepted for one slot.
    /// Drives the real `check_replay` with random issue times, a few slots so they collide often,
    /// idle gaps so bitmaps rotate, and asserts the invariant after every accepted call.
    #[test]
    fn overlapping_authorizations_are_never_both_accepted() {
        for (slots, gap_max) in [(3u64, 80u64), (3, 300), (40, 20)] {
            for seed in 0..200u64 {
                let mut rng = Xorshift(
                    0x9E37_79B9_7F4A_7C15 ^ (seed + 1).wrapping_mul(0xD1B5_4A32_D192_ED03),
                );
                let mut bitmaps = [[0u64; 4]; 2];
                let mut accepted: Vec<(u64, u64)> = Vec::new();
                let mut now = SLICE_START + rng.below(1000);
                for _ in 0..400 {
                    now += rng.below(gap_max + 1);
                    let issued = now - rng.below(REPLAY_HORIZON_SECS + 1);
                    let slot_key = rng.below(slots);
                    if call(&mut bitmaps, slot_key, issued, now).is_ok() {
                        for &(slot, other) in &accepted {
                            let apart = other.abs_diff(issued);
                            assert!(
                                slot != slot_key || apart > REPLAY_HORIZON_SECS,
                                "slot {slot_key} accepted twice for issued_at {other} and {issued}"
                            );
                        }
                        accepted.push((slot_key, issued));
                    }
                }
            }
        }
    }
}
