package stellar_escrow_encoding

import "errors"

// Validation errors for encoder parameters, mirroring the guards the contract enforces in `deposit`,
// `release` and `refund` (docs/witness-layouts.md, "Checks the encoders must mirror"). They can be
// checked using errors.Is() for specific error handling.
var (
	// ErrZeroDepositRequestHash is returned when the deposit request hash is all zeros
	// (DepositRequestHashCannotBeEmpty).
	ErrZeroDepositRequestHash = errors.New("deposit request hash cannot be zero")
	// ErrEmptyDestination is returned when the committed destination is empty (DestinationCannotBeEmpty).
	ErrEmptyDestination = errors.New("destination cannot be empty")
	// ErrDestinationTooLong is returned when the destination exceeds MaxDestinationLen bytes
	// (DestinationTooLong).
	ErrDestinationTooLong = errors.New("destination exceeds the maximum length")

	// ErrInvalidDestination is returned when the destination is not valid UTF-8. A destination is text, and
	// TypeScript cannot hold anything else (a lone surrogate would hash as U+FFFD), so both reject it.
	ErrInvalidDestination = errors.New("destination must be valid UTF-8")

	// ErrZeroReserver is returned when the reserver key is all zeros (ReserverCannotBeZero).
	ErrZeroReserver = errors.New("reserver cannot be zero")
	// ErrZeroReleaser is returned when the releaser key is all zeros (ReleaserCannotBeZero).
	ErrZeroReleaser = errors.New("releaser cannot be zero")

	// ErrZeroAmount is returned when the deposit ceiling is not positive (InvalidAmount).
	ErrZeroAmount = errors.New("amount cannot be zero")
	// ErrZeroSourceAmount is returned when the reserved source amount is not positive
	// (InvalidSourceAmount): reserving zero would settle a payment that moved no value.
	ErrZeroSourceAmount = errors.New("source amount cannot be zero")
	// ErrInvalidSourceAmount is returned by CheckSourceAmount when source_amount exceeds the signed
	// ceiling (InvalidSourceAmount).
	ErrInvalidSourceAmount = errors.New("source amount exceeds the deposit amount")
	// ErrAmountOutOfRange is returned when an amount is nil, negative, or above i128::MAX, so it has no
	// 16-byte encoding the contract could have produced.
	ErrAmountOutOfRange = errors.New("amount must be an i128 between 0 and 2^127-1")

	// ErrZeroDepositID is returned when the deposit id (the deposit digest) is all zeros. The contract
	// answers a wrong id with DepositIdMismatch; a zero one is never the digest of anything.
	ErrZeroDepositID = errors.New("deposit id cannot be zero")
	// ErrZeroQuoteHash is returned when the quote hash is all zeros (QuoteHashCannotBeEmpty). Unlike
	// Solana, the Soroban release and refund enforce it too.
	ErrZeroQuoteHash = errors.New("quote hash cannot be zero")

	// ErrInconsistentTimestamps is returned when issued_at is after deadline (InconsistentTimestamps).
	ErrInconsistentTimestamps = errors.New("issued_at is after deadline")
	// ErrDeadlineTooFarInFuture is returned when deadline - issued_at exceeds MaxDepositValiditySecs
	// (DeadlineTooFarInFuture).
	ErrDeadlineTooFarInFuture = errors.New("deadline is more than 24 hours after issued_at")

	// ErrInvalidStrkey is returned for text that is not a well-formed G... or C... strkey: bad base32,
	// checksum, length, or a version byte that is not an address (a secret seed is never accepted).
	ErrInvalidStrkey = errors.New("invalid strkey")
	// ErrUnsupportedAddress is returned for a well-formed strkey the layout cannot represent: muxed (M...)
	// and claimable-balance (B...) addresses (UnsupportedAddress on chain).
	ErrUnsupportedAddress = errors.New("unsupported address type: only G... accounts and C... contracts have a fixed-width form")

	// ErrInvalidPubkeyLength is returned when a key does not have 32 bytes.
	ErrInvalidPubkeyLength = errors.New("invalid key length: expected 32 bytes")
	// ErrInvalidHex is returned when hex decoding fails.
	ErrInvalidHex = errors.New("invalid hex encoding")
)

// ErrInvalidEscrowDomain is returned when an EscrowDomain field is unusable.
var ErrInvalidEscrowDomain = errors.New("invalid escrow domain")
