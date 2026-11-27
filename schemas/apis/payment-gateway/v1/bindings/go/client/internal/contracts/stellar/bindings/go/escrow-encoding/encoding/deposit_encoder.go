package stellar_escrow_encoding

import (
	"math/big"
	"unicode/utf8"
)

// EscrowDepositParams contains the parameters needed to compute the deposit digest.
type EscrowDepositParams struct {
	// DepositRequestHash is the commitment to the offchain deposit request. Its derivation is defined by
	// the offchain protocol layer; the contract only requires it to be non-zero.
	DepositRequestHash [32]byte

	// Destination is the plaintext `<CAIP-19 asset>@<account>` the payer commits to, 1 to
	// MaxDestinationLen bytes. It is committed as keccak256(destination), never fed raw.
	Destination string

	// Depositor is the account whose SEP-41 allowance funds the deposit. It does not sign the digest.
	Depositor Address

	// Token is the SEP-41 token contract.
	Token Address

	// Epoch is the epoch of the delegate record that authorises the deposit (`get_delegate(...).epoch`,
	// or the value `create_delegate` returned, which `DelegateCreated.epoch` also carries): 1 for the first record of the (depositor, token), +1 for each
	// re-creation, kept across revokes. It binds the signature to one record, so a deposit signed before a
	// revoke stays dead when the same signer key is enrolled again.
	Epoch uint64

	// Amount is the ceiling the depositor authorises (DepositInput.amount), not the charge: the delegate
	// signs it before the auction, so it commits to the ceiling.
	Amount *big.Int

	// Reserver is the raw ed25519 key that signs the reserve digest.
	Reserver Pubkey

	// Releaser is the raw ed25519 key that signs the release and refund digests.
	Releaser Pubkey

	// Nonce is unordered and per depositor; it can never be reused.
	Nonce uint64

	// IssuedAt is seconds. The contract requires it to be <= ledger time.
	IssuedAt uint64

	// Deadline is seconds. The contract requires it to be >= ledger time and <= IssuedAt + 86400.
	Deadline uint64
}

// ComputeDestinationHash is keccak256 of the destination's UTF-8 bytes.
//
// The single place the destination becomes bytes for hashing, mirroring the contract's
// `destination_hash`, and identical to EVM, TVM and SVM for the same string. Keeping it separate is what
// makes the hash-first rule enforceable rather than conventional: ComputeDepositHash never concatenates
// a string.
func ComputeDestinationHash(destination string) [32]byte {
	return Keccak256([]byte(destination))
}

// ComputeDepositHash computes the deposit digest, which is also the deposit id.
//
// This digest is signed once, before the auction, by the depositor's delegate signer (ed25519 over the
// 32 digest bytes, no prefix or framing). It is the id every later reserve, release and refund names.
//
// Hash formula (Rust source: `compute_deposit_hash`, 320 bytes):
//
//	keccak256(
//	    "escrow" || version[1] || network_id[32] || contract_id[32] ||
//	    "deposit" || deposit_request_hash[32] || destination_hash[32] || depositor[33] || token[33] || epoch[8,LE] ||
//	    amount[16,LE] || reserver[32] || releaser[32] ||
//	    nonce[8,LE] || issued_at[8,LE] || deadline[8,LE]
//	)
//
// The guards run in the contract's order. The ledger-time ones (issued_at and deadline against the latest
// closed ledger's close time) cannot be checked offline and stay the caller's job.
func ComputeDepositHash(params EscrowDepositParams, domain EscrowDomain) ([32]byte, error) {
	var zero32 [32]byte
	if params.Reserver.IsZero() {
		return zero32, ErrZeroReserver
	}
	if params.Releaser.IsZero() {
		return zero32, ErrZeroReleaser
	}
	if params.DepositRequestHash == zero32 {
		return zero32, ErrZeroDepositRequestHash
	}
	if params.Destination == "" {
		return zero32, ErrEmptyDestination
	}
	if len(params.Destination) > MaxDestinationLen {
		return zero32, ErrDestinationTooLong
	}
	if !utf8.ValidString(params.Destination) {
		return zero32, ErrInvalidDestination
	}
	amount, err := EncodeAmount16(params.Amount)
	if err != nil {
		return zero32, err
	}
	if params.Amount.Sign() == 0 {
		return zero32, ErrZeroAmount
	}
	if params.IssuedAt > params.Deadline {
		return zero32, ErrInconsistentTimestamps
	}
	if params.Deadline-params.IssuedAt > MaxDepositValiditySecs {
		return zero32, ErrDeadlineTooFarInFuture
	}
	if !params.Depositor.valid() || !params.Token.valid() {
		return zero32, ErrUnsupportedAddress
	}

	destinationHash := ComputeDestinationHash(params.Destination)
	depositor, token := params.Depositor.Bytes33(), params.Token.Bytes33()
	return hashWithDomain(domain, "deposit",
		params.DepositRequestHash[:],
		// Hash first: Keccak256 concatenates without length prefixes, so injectivity depends on every
		// hashed field being fixed-width. Feeding the raw string would make it conditional on the
		// surrounding widths and diverge from the contract, which hashes it too.
		destinationHash[:],
		depositor[:],
		token[:],
		EncodeU64LE(params.Epoch),
		amount,
		params.Reserver[:],
		params.Releaser[:],
		EncodeU64LE(params.Nonce),
		EncodeU64LE(params.IssuedAt),
		EncodeU64LE(params.Deadline),
	)
}
