package svm_escrow_encoding

import "errors"

// Validation errors for encoder parameters.
// These can be checked using errors.Is() for specific error handling.
var (
	// ErrZeroDepositRequestHash is returned when the deposit request hash is all zeros.
	ErrZeroDepositRequestHash = errors.New("deposit request hash cannot be zero")
	// ErrEmptyDestination is returned when the committed destination is empty.
	ErrEmptyDestination = errors.New("destination cannot be empty")
	// ErrDestinationTooLong is returned when the destination exceeds MaxDestinationLen bytes.
	ErrDestinationTooLong = errors.New("destination exceeds the maximum length")
	// ErrDestinationNotUTF8 is returned when the destination is not valid UTF-8.
	ErrDestinationNotUTF8 = errors.New("destination is not valid UTF-8")

	// ErrZeroDepositor is returned when the depositor pubkey is all zeros.
	ErrZeroDepositor = errors.New("depositor cannot be zero")

	// ErrZeroMint is returned when the mint pubkey is all zeros.
	ErrZeroMint = errors.New("mint cannot be zero")

	// ErrZeroAmount is returned when the deposit amount is zero.
	ErrZeroAmount = errors.New("amount cannot be zero")

	// ErrZeroReserver is returned when the reserver pubkey is all zeros.
	ErrZeroReserver = errors.New("reserver cannot be zero")

	// ErrZeroReleaser is returned when the releaser pubkey is all zeros.
	ErrZeroReleaser = errors.New("releaser cannot be zero")

	// ErrZeroRecipient is returned when the recipient pubkey is all zeros.
	ErrZeroRecipient = errors.New("recipient cannot be zero")

	// ErrZeroDepositHash is returned when the deposit hash is all zeros.
	// Used by reserve, release, and refund encoders.
	ErrZeroDepositHash = errors.New("deposit hash cannot be zero")

	// ErrZeroQuoteHash is returned when the V2 reserve quote hash is all zeros.
	// The on-chain reserve rejects an empty quote_hash with ErrorCode::QuoteHashCannotBeEmpty;
	// release and refund bind the stored value (zero for a never-reserved refund), so they
	// do not enforce this.
	ErrZeroQuoteHash = errors.New("quote hash cannot be zero")

	// ErrZeroSourceAmount is returned when the V3 reserve source amount is zero.
	// The on-chain reserve rejects it (AmountCannotBeZero): reserving zero would narrow the
	// deposit to nothing, so release would consume the deposit and pay the settler nothing while
	// the payer's funds returned as surplus — a settled payment that moved no value.
	ErrZeroSourceAmount = errors.New("source amount cannot be zero")

	// ErrNotSolanaRequest is returned when attempting to compute a Solana payment ID
	// from a PaymentRequest that doesn't use the SOLANA message scheme.
	ErrNotSolanaRequest = errors.New("payment request is not a Solana request (message_scheme must be SOLANA)")

	// ErrMissingSignedMessages is returned when a PaymentRequest has no signed messages.
	ErrMissingSignedMessages = errors.New("signed_messages array is empty")

	// ErrMissingMessagePrehash is returned when a Solana PaymentRequest is missing
	// the required message_prehash field in the first signed message.
	ErrMissingMessagePrehash = errors.New("message_prehash is required for Solana requests")

	// ErrMissingSenderAuth is returned when a PaymentRequest carries no sender_auth.
	// sender_auth is optional on the unified PaymentRequest schema (a quote-request
	// omits it), but it is mandatory to derive a Solana deposit_hash.
	ErrMissingSenderAuth = errors.New("sender_auth is required to compute deposit_request_hash")
)

// ErrInvalidEscrowDomain is returned when an EscrowDomain field is unusable. The domain guards
// used to return bare fmt.Errorf values, which a caller could not match with errors.Is the way
// every other guard in this package allows.
var ErrInvalidEscrowDomain = errors.New("invalid escrow domain")
