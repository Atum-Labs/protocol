// SPDX-License-Identifier: MIT
use crate::errors::ErrorCode;
use crate::state::ReplayBucket;
use anchor_lang::prelude::*;
use replay::ReplayError;

pub fn check_replay(
    bucket: &mut ReplayBucket,
    nonce: u64,
    issued_at: u64,
    deadline: u64,
    now_sec: u64,
) -> Result<()> {
    replay::check_replay(&mut bucket.bitmaps, nonce, issued_at, deadline, now_sec).map_err(|e| {
        match e {
            ReplayError::DeadlineExpired => error!(ErrorCode::DeadlineExpired),
            ReplayError::InconsistentTimestamps => error!(ErrorCode::InconsistentTimestamps),
            ReplayError::FutureTransaction => error!(ErrorCode::FutureTransaction),
            ReplayError::ExpiredTransaction => error!(ErrorCode::ExpiredTransaction),
            ReplayError::DeadlineTooFarInFuture => error!(ErrorCode::DeadlineTooFarInFuture),
            ReplayError::InvalidSlot => error!(ErrorCode::InvalidSlot),
            // Deliberately not `DuplicateTransaction`, unlike escrow's mapping of the same
            // variant, because this program has a fulfilment marker and escrow does not.
            //
            // The code is raised two ways and they are not interchangeable. The marker is
            // keyed on quote_hash and settler; this bucket is keyed on settler and nonce. They
            // share only the settler, so a nonce already burned by a different quote from the
            // same settler lands here for a quote that was never fulfilled. Read this
            // settler's marker account for the quote to tell them apart: set means idempotent
            // success, absent means a replay-slot collision and the quote should be re-planned
            // at a fresh nonce.
            ReplayError::DuplicateTransaction => error!(ErrorCode::AlreadyFulfilled),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The replay crate owns the wording and Anchor's `#[msg]` cannot read it, so this is what stops
    /// the two copies drifting. Driven off `ReplayError::ALL`, so adding a variant to the crate
    /// without giving it a case here fails to compile rather than silently going unchecked.
    #[test]
    fn replay_messages_match_the_crate() {
        for source in ReplayError::ALL {
            let mapped = match source {
                ReplayError::DeadlineExpired => ErrorCode::DeadlineExpired,
                ReplayError::InconsistentTimestamps => ErrorCode::InconsistentTimestamps,
                ReplayError::FutureTransaction => ErrorCode::FutureTransaction,
                ReplayError::ExpiredTransaction => ErrorCode::ExpiredTransaction,
                ReplayError::DeadlineTooFarInFuture => ErrorCode::DeadlineTooFarInFuture,
                ReplayError::InvalidSlot => ErrorCode::InvalidSlot,
                // Deliberately renamed, so it is pinned separately below rather than compared here.
                ReplayError::DuplicateTransaction => continue,
            };
            assert_eq!(
                mapped.to_string(),
                source.message(),
                "{source:?} wording drifted from the replay crate"
            );
        }
    }

    /// The one deliberate rename. Pinned to a literal rather than a loose `contains`, so a reword
    /// that stopped telling the caller the quote was already fulfilled would fail here.
    #[test]
    fn duplicate_is_renamed_deliberately() {
        assert_eq!(
            ErrorCode::AlreadyFulfilled.to_string(),
            "This quote has already been strictly fulfilled"
        );
    }
}
