package svm_escrow_encoding

import "encoding/json"

// EscrowReleaseParams contains the parameters needed to compute a release message hash.
type EscrowReleaseParams struct {
	// DepositHash is the 32-byte deposit hash returned by ComputeDepositHash.
	// This serves as the unique identifier for the payment.
	DepositHash [32]byte
}

// SolanaReleasePrehash represents the JSON structure of the message_prehash
// field for Solana escrow release operations.
//
// Example JSON:
//
//	{
//	  "deposit_hash": "0xeb7fa9a1815c8d3955626717d017ffd8c2d2d586fd1bd29d05ea7fe8968894de"
//	}
type SolanaReleasePrehash struct {
	// DepositHash is the hex-encoded 32-byte deposit hash (with 0x prefix).
	DepositHash string `json:"deposit_hash"`
}

// ToJSON serializes the prehash to JSON bytes.
func (p *SolanaReleasePrehash) ToJSON() ([]byte, error) {
	return json.Marshal(p)
}

// ComputeReleaseHash computes the release message hash under the frozen pre-quote-hash layout
// (signature_domain_version 1 and 2). The current program refuses it; use ComputeReleaseHashV2 for
// domain versions 3 and above.
//
// This hash must be signed by the releaser to authorize fund release.
//
// Hash formula (the program's layout at domain versions 1 and 2):
//
//	keccak256(
//	    "escrow" || version[1] || cluster_id[32] || program_id[32] ||
//	    "release" || deposit_hash[32]
//	)
func ComputeReleaseHash(params EscrowReleaseParams, domain EscrowDomain) ([32]byte, error) {
	var zero32 [32]byte
	if params.DepositHash == zero32 {
		return zero32, ErrZeroDepositHash
	}

	prefix, err := EscrowDomainPrefixBytes(domain)
	if err != nil {
		return zero32, err
	}

	parts := append(prefix,
		[]byte("release"),
		params.DepositHash[:],
	)

	return Keccak256(parts...), nil
}

// SolanaReleasePrehashV2 is the message_prehash for the V2 release operation, binding the
// offchain quote hash. Additive — the V1 SolanaReleasePrehash above is unchanged.
// quote_hash is appended LAST so a verifier can re-derive
// keccak256(... || "release" || deposit_hash || quote_hash).
type SolanaReleasePrehashV2 struct {
	// DepositHash is the hex-encoded 32-byte deposit hash (with 0x prefix).
	DepositHash string `json:"deposit_hash"`
	// QuoteHash is the hex-encoded 32-byte offchain quote hash (with 0x prefix).
	QuoteHash string `json:"quote_hash"`
}

// ToJSON serializes the V2 prehash to JSON bytes.
func (p *SolanaReleasePrehashV2) ToJSON() ([]byte, error) {
	return json.Marshal(p)
}

// ComputeReleaseHashV2 computes the V2 release message hash, binding the offchain quote hash
// appended LAST, so a release is anchored to the quote it settles. Additive —
// ComputeReleaseHash above is unchanged. Rust source: `compute_release_hash`:
//
//	keccak256(
//	    "escrow" || version[1] || cluster_id[32] || program_id[32] ||
//	    "release" || deposit_hash[32] || quote_hash[32]
//	)
//
// quote_hash is the value bound at reserve (stored on the deposit), so this does not enforce
// non-emptiness.
func ComputeReleaseHashV2(params EscrowReleaseParams, quoteHash [32]byte, domain EscrowDomain) ([32]byte, error) {
	var zero32 [32]byte
	if params.DepositHash == zero32 {
		return zero32, ErrZeroDepositHash
	}

	prefix, err := EscrowDomainPrefixBytes(domain)
	if err != nil {
		return zero32, err
	}

	parts := append(prefix,
		[]byte("release"),
		params.DepositHash[:],
		quoteHash[:],
	)

	return Keccak256(parts...), nil
}
