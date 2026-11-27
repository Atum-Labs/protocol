/// Why a replay check refused a nonce.
///
/// This crate owns the wording. Anchor's `#[msg]` takes a string literal and cannot read a const or
/// call a function, so each program must repeat the text — the copies are enforced rather than
/// avoided, by a test in each program asserting its `#[msg]` still equals `message()`. Reword here
/// and those tests fail until the literals are updated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayError {
    /// `now > deadline`. The authorization's own deadline has passed.
    DeadlineExpired,
    /// `deadline < issued_at`, or `issued_at + REPLAY_HORIZON_SECS` overflows. The two timestamps
    /// cannot both be true, so the authorization is unusable rather than merely late.
    InconsistentTimestamps,
    /// `now < issued_at`. The authorization is stamped in the future.
    FutureTransaction,
    /// `now` is past the replay horizon measured from `issued_at`, so the nonce is no longer
    /// tracked and reuse could not be detected.
    ExpiredTransaction,
    /// `deadline` is past the replay horizon, so honouring it would outlive the replay window.
    DeadlineTooFarInFuture,
    /// The slot derived from the nonce is outside the bitmap.
    InvalidSlot,
    /// This nonce has already been used inside the replay window.
    DuplicateTransaction,
}

impl ReplayError {
    /// Every variant, so a consumer can assert it handled all of them. Adding a variant without
    /// extending this array is a compile error, which is what stops a new condition being added
    /// with no wording and no test.
    pub const ALL: [Self; 7] = [
        Self::DeadlineExpired,
        Self::InconsistentTimestamps,
        Self::FutureTransaction,
        Self::ExpiredTransaction,
        Self::DeadlineTooFarInFuture,
        Self::InvalidSlot,
        Self::DuplicateTransaction,
    ];

    /// The canonical wording for this condition. Programs mirror it in their `#[msg]` literals.
    pub const fn message(self) -> &'static str {
        match self {
            Self::DeadlineExpired => "The authorization deadline has passed",
            Self::InconsistentTimestamps => {
                "The authorization's deadline is before its issued_at, or its replay horizon overflows"
            }
            Self::FutureTransaction => "The authorization is stamped in the future",
            Self::ExpiredTransaction => {
                "The authorization is older than the replay window, so nonce reuse can no longer be detected"
            }
            Self::DeadlineTooFarInFuture => {
                "The authorization deadline is beyond the replay window"
            }
            Self::InvalidSlot => "The nonce maps to a slot outside the replay bitmap",
            Self::DuplicateTransaction => "This nonce has already been used inside the replay window",
        }
    }
}

impl core::fmt::Display for ReplayError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.message())
    }
}
