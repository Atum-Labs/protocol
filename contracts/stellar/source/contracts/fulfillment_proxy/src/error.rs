// SPDX-License-Identifier: MIT
use soroban_sdk::contracterror;

/// Codes are append-only: offchain matchers key on the number, so a variant is never inserted or
/// renumbered (same rule as the Solana program's ErrorCode). Code 1 was an `Unauthorized` that
/// nothing returned (auth failures trap in `require_auth`); it is retired and not reused.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    Paused = 2,
    DeadlineExpired = 3,
    AlreadyFulfilled = 4,
    QuoteHashCannotBeEmpty = 5,
    ZeroAmount = 6,
    UnauthorizedSettler = 7,
    NoPendingAdminTransfer = 8,
    AdminTransferNotReady = 9,
    TimestampOverflow = 10,
    NotPaused = 11,
    NoPendingDelayChange = 12,
    NonceAlreadyUsed = 16,
}
