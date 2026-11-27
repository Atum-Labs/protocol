package svm_escrow_encoding

import "unicode/utf8"

// EscrowDepositParams contains the parameters needed to compute a deposit message hash.
type EscrowDepositParams struct {
	// DepositRequestHash is the depositor-signed commitment to the offchain deposit request.
	// Formerly PaymentID; renamed for parity with EVM and TVM, which call the same value
	// depositRequestHash. Its derivation is defined by the offchain protocol layer.
	// In the new architecture, this can be any value (e.g., keccak256(request_id)).
	// The deposit_hash (output of Digest) is used as the unique identifier and PDA seed.
	DepositRequestHash [32]byte

	// Depositor is the 32-byte Solana public key of the user depositing funds.
	Depositor Pubkey

	// Mint is the 32-byte Solana public key of the SPL token mint.
	Mint Pubkey

	// Amount is the number of tokens being deposited (in smallest units).
	Amount uint64

	// Reserver is the 32-byte Solana public key authorized to reserve funds.
	Reserver Pubkey

	// Releaser is the 32-byte Solana public key authorized to release/refund funds.
	Releaser Pubkey

	// Nonce is a unique value for replay protection.
	Nonce uint64

	// IssuedAt is the Unix timestamp (seconds) when the authorization was created, marking the start of the 128-second validity window (REPLAY_HORIZON_SECS).
	IssuedAt uint64

	// Deadline is the Unix timestamp (seconds) after which the deposit expires.
	Deadline uint64
}

// ComputeDepositHash computes the V3 deposit_hash for the Solana escrow deposit operation.
//
// The deposit_hash serves as:
// 1. The unique identifier for this deposit (analogous to EVM's paymentID)
// 2. The PDA seed for the escrow account
// 3. The input to reserve, release, and refund hash computations
//
// This hash must be signed by the depositor to authorize the escrow deposit.
//
// Hash formula (Rust source: `compute_deposit_hash`):
//
//	keccak256(
//	    "escrow" || version[1] || cluster_id[32] || program_id[32] ||
//	    "deposit" || deposit_request_hash[32] || depositor[32] || mint[32] ||
//	    amount[8,LE] || reserver[32] || releaser[32] ||
//	    nonce[8,LE] || issued_at[8,LE] || deadline[8,LE]
//	)
//
// This layout is FROZEN. It is what signature_domain_version 1..=3 committed to, and historical
// deposits are still verified against it, so it must never change. The destination commitment lives in
// ComputeDepositHashV2 instead — mirroring how the quote-hash binding left ComputeReserveHash untouched and added
// ComputeReserveHashV2 beside it.
//
// Witness revision to domain version, since the two numbers deliberately do not match:
//
//	domain v1, v2:  ComputeDepositHash   + ComputeReserveHash   / ComputeReleaseHash   / ComputeRefundHash
//	domain v3:      ComputeDepositHash   + ComputeReserveHashV2 / ComputeReleaseHashV2 / ComputeRefundHashV2
//	domain v4:      ComputeDepositHashV2 + ComputeReserveHashV2 / ComputeReleaseHashV2 / ComputeRefundHashV2
//
// Each suffix counts revisions of ITS OWN witness; deposit simply changed one revision later than the
// other three, because the quote hash did not touch the deposit preimage.
func ComputeDepositHash(params EscrowDepositParams, domain EscrowDomain) ([32]byte, error) {
	var zero32 [32]byte
	if params.DepositRequestHash == zero32 {
		return zero32, ErrZeroDepositRequestHash
	}

	if params.Depositor.IsZero() {
		return zero32, ErrZeroDepositor
	}

	if params.Mint.IsZero() {
		return zero32, ErrZeroMint
	}

	if params.Amount == 0 {
		return zero32, ErrZeroAmount
	}

	if params.Reserver.IsZero() {
		return zero32, ErrZeroReserver
	}

	if params.Releaser.IsZero() {
		return zero32, ErrZeroReleaser
	}
	prefix, err := EscrowDomainPrefixBytes(domain)
	if err != nil {
		return zero32, err
	}

	parts := append(prefix,
		[]byte("deposit"),
		params.DepositRequestHash[:],
		params.Depositor[:],
		params.Mint[:],
		EncodeU64LE(params.Amount),
		params.Reserver[:],
		params.Releaser[:],
		EncodeU64LE(params.Nonce),
		EncodeU64LE(params.IssuedAt),
		EncodeU64LE(params.Deadline),
	)

	return Keccak256(parts...), nil
}

// MaxDestinationLen is the maximum byte length of the committed destination.
//
// 256 is uniform across EVM, TVM and SVM so one client signing-policy rule covers every chain. Note the
// Solana-specific ceiling beneath it: a LEGACY transaction admits only about 152 bytes of destination at
// the current 17-key/2-signature deposit shape, so anything larger requires a v0 transaction with an
// address lookup table. Real destinations are ~103 bytes (eip155) and ~135 bytes (solana), so normal
// traffic never approaches either limit.
const MaxDestinationLen = 256

// ComputeDestinationHash is keccak256 of the destination's UTF-8 bytes.
//
// The single place the destination becomes bytes for hashing, mirroring the on-chain
// compute_destination_hash. Keeping it separate is what makes the hash-first rule enforceable rather
// than conventional: ComputeDepositHash takes no string for hashing, so a raw feed cannot be written by
// accident. TestRawDestinationFeedIsRejected pins the distinction.
func ComputeDestinationHash(destination string) [32]byte {
	return Keccak256([]byte(destination))
}

// ValidateAndHashDestination enforces the destination rules (non-empty, valid UTF-8, at most
// MaxDestinationLen bytes) and returns its hash, the destination_hash argument of the
// escrow-text-v1 deposit instruction. ComputeDepositHashV2 keeps the v4 checks unchanged.
func ValidateAndHashDestination(destination string) ([32]byte, error) {
	if destination == "" {
		return [32]byte{}, ErrEmptyDestination
	}
	if !utf8.ValidString(destination) {
		return [32]byte{}, ErrDestinationNotUTF8
	}
	if len(destination) > MaxDestinationLen {
		return [32]byte{}, ErrDestinationTooLong
	}
	return ComputeDestinationHash(destination), nil
}

// ComputeDepositHashV2 is the signature_domain_version 4 deposit witness: ComputeDepositHash's preimage
// with keccak256(destination) inserted directly after deposit_request_hash.
//
//	keccak256(
//	    "escrow" || version[1] || cluster_id[32] || program_id[32] ||
//	    "deposit" || deposit_request_hash[32] || destination_hash[32] || depositor[32] || mint[32] ||
//	    amount[8,LE] || reserver[32] || releaser[32] ||
//	    nonce[8,LE] || issued_at[8,LE] || deadline[8,LE]
//	)
//
// destination is the plaintext `<CAIP-19 asset>@<account>` the payer commits to: lowercase throughout
// EXCEPT base58 segments (Solana genesis reference, SPL mint, account), which are case-significant and
// preserved byte-for-byte. It is NOT normalised here — the commitment is over the exact bytes the payer
// signed, so re-casing or trimming would silently produce a hash the program rejects.
//
// The preimage is spelled out rather than delegating to ComputeDepositHash because each revision must be
// independently frozen: sharing the construction would let a future edit to one silently change the
// other's bytes. This mirrors ComputeReserveHashV2.
func ComputeDepositHashV2(params EscrowDepositParams, destination string, domain EscrowDomain) ([32]byte, error) {
	var zero32 [32]byte
	if params.DepositRequestHash == zero32 {
		return zero32, ErrZeroDepositRequestHash
	}

	if params.Depositor.IsZero() {
		return zero32, ErrZeroDepositor
	}

	if params.Mint.IsZero() {
		return zero32, ErrZeroMint
	}

	if params.Amount == 0 {
		return zero32, ErrZeroAmount
	}

	if params.Reserver.IsZero() {
		return zero32, ErrZeroReserver
	}

	if params.Releaser.IsZero() {
		return zero32, ErrZeroReleaser
	}

	if destination == "" {
		return zero32, ErrEmptyDestination
	}

	if len(destination) > MaxDestinationLen {
		return zero32, ErrDestinationTooLong
	}

	prefix, err := EscrowDomainPrefixBytes(domain)
	if err != nil {
		return zero32, err
	}

	destinationHash := ComputeDestinationHash(destination)
	parts := append(prefix,
		[]byte("deposit"),
		params.DepositRequestHash[:],
		// Hash first: Keccak256 concatenates without length prefixes, so injectivity depends on every
		// hashed field being fixed-width. Feeding the raw string would make it conditional on the
		// surrounding widths and diverge from the on-chain program, which hashes it too.
		// TestRawDestinationFeedIsRejected pins the distinction.
		destinationHash[:],
		params.Depositor[:],
		params.Mint[:],
		EncodeU64LE(params.Amount),
		params.Reserver[:],
		params.Releaser[:],
		EncodeU64LE(params.Nonce),
		EncodeU64LE(params.IssuedAt),
		EncodeU64LE(params.Deadline),
	)

	return Keccak256(parts...), nil
}
