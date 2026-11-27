use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Caller is not authorized for this operation")]
    Unauthorized,
    #[msg("Protocol already initialized")]
    AlreadyInitialized,
    #[msg("Protocol is paused")]
    ProtocolPaused,
    #[msg("Admin transfer not ready - delay not elapsed")]
    AdminTransferNotReady,
    #[msg("The authorization deadline has passed")]
    DeadlineExpired,
    #[msg("The authorization deadline is beyond the replay window")]
    DeadlineTooFarInFuture,
    #[msg("The authorization is stamped in the future")]
    FutureTransaction,
    #[msg("The authorization is older than the replay window, so nonce reuse can no longer be detected")]
    ExpiredTransaction,
    #[msg("The nonce maps to a slot outside the replay bitmap")]
    InvalidSlot,
    /// Reserved. Nothing raises this any more: the two conditions it used to conflate have their
    /// own variants appended below. Kept declared so the codes after it do not move.
    #[msg("Reserved, not raised")]
    InvalidData,
    #[msg("This quote has already been strictly fulfilled")]
    AlreadyFulfilled,
    /// Reserved. Both conditions that raised it — a full authorized-settler list and a timestamp
    /// overflow — now have their own variants appended below. Neither was about an amount.
    #[msg("Reserved, not raised")]
    CapacityExceeded,
    #[msg("Settler is not authorized to strictly fulfill")]
    UnauthorizedSettler,
    #[msg("Quote hash must not be empty")]
    QuoteHashCannotBeEmpty,

    // APPENDED, NOT INSERTED. Anchor assigns error codes by declaration order, so adding a variant
    // mid-enum renumbers every later one — a silent ABI break for any offchain matcher keyed on the
    // numeric code. New variants go at the end.
    /// The fulfillment amount was zero.
    #[msg("The fulfillment amount must be greater than zero")]
    AmountCannotBeZero,

    /// `deadline < issued_at`, or the replay horizon overflows. Mirrors
    /// `replay::ReplayError::InconsistentTimestamps`.
    #[msg("The authorization's deadline is before its issued_at, or its replay horizon overflows")]
    InconsistentTimestamps,

    /// The authorized-settler allowlist is already at MAX_AUTHORIZED_SETTLERS.
    #[msg("The authorized settler list is full")]
    AuthorizedSettlerListFull,

    /// A checked timestamp addition overflowed.
    #[msg("A timestamp calculation overflowed")]
    TimestampOverflow,

    /// The recipient was not credited exactly `amount`, for example by a Token-2022 transfer fee.
    /// The event reports `amount`, so a short credit must not succeed.
    #[msg("Recipient did not receive the exact fulfillment amount")]
    NonExactTransfer,
}
