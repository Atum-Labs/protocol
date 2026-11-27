// SPDX-License-Identifier: MIT
use soroban_sdk::contracterror;

/// Codes are append-only: clients map them by number.
///
/// A failed signature is NOT in this list. `Crypto::ed25519_verify` has no boolean form; the host
/// traps (a `Crypto`/`InvalidInput` host error), the whole invocation reverts, and the caller sees
/// that host error rather than a contract code. Tests pin that behaviour.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // Access control
    MissingRole = 1,
    NoPendingAdminTransfer = 2,
    AdminTransferNotReady = 3,
    NoPendingDelayChange = 4,
    // 5 was `NotPendingAdmin`, never returned (acceptance traps in `require_auth`); retired, not reused
    TimestampOverflow = 6,
    // Pause
    Paused = 10,
    NotPaused = 11,
    // Token config
    TokenNotAllowed = 20,
    TokenAlreadyAllowed = 21,
    TokenDecimalsCannotBeZero = 22,
    TokenDecimalsExceedMaximum = 23,
    TokenDecimalsMismatch = 24,
    MinFeeCannotBeGreaterThanMaxFee = 25,
    FeePercentageCannotBeZeroWhenMaxFeeIsSet = 26,
    FeePercentageExceedsMaximum = 27,
    MinFeeNotRepresentable = 28,
    MaxFeeNotRepresentable = 29,
    FeeExceedsDepositAmount = 30,
    FeeArithmeticFailed = 31,
    NoFeesToWithdraw = 32,
    RecipientCannotBeSelf = 33,
    InvalidAmount = 34,
    // Deposit witness
    ReserverCannotBeZero = 40,
    ReleaserCannotBeZero = 41,
    DepositRequestHashCannotBeEmpty = 42,
    DestinationCannotBeEmpty = 43,
    DestinationTooLong = 44,
    QuoteHashCannotBeEmpty = 45,
    InvalidSourceAmount = 46,
    DepositIdMismatch = 47,
    // Replay protection
    DeadlineExpired = 50,
    InconsistentTimestamps = 51,
    FutureDeposit = 52,
    DeadlineTooFarInFuture = 53,
    NonceAlreadyUsed = 54,
    // Deposit lifecycle
    DepositAlreadyExists = 60,
    DepositNotFound = 61,
    InvalidWitnessValues = 62,
    NonExactTransfer = 63,
    UnsupportedAddress = 64,
    // Delegate
    DelegateNotFound = 70,
    DelegateAlreadyExists = 71,
    DelegateLimitsInvalid = 72,
    DelegateExpired = 73,
    DelegateOverCapacity = 74,
    DelegateOverTransferMax = 75,
    InvalidDelegateSigner = 76,
    InvalidExpiration = 77,
    QuoteAlreadyUsed = 78,
    SettlerCannotBeSelf = 81,
}
