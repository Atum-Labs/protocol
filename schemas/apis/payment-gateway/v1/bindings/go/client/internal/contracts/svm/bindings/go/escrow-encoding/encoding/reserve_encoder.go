package svm_escrow_encoding

import "encoding/json"

// EscrowReserveParams contains the parameters needed to compute a reserve message hash.
type EscrowReserveParams struct {
	// DepositHash is the 32-byte deposit hash returned by ComputeDepositHash.
	// This serves as the unique identifier for the payment.
	DepositHash [32]byte

	// Recipient is the 32-byte Solana public key of the fund recipient on the destination chain.
	Recipient Pubkey
}

// SolanaReservePrehash represents the JSON structure of the message_prehash
// field for Solana escrow reserve operations.
//
// Example JSON:
//
//	{
//	  "deposit_hash": "0xeb7fa9a1815c8d3955626717d017ffd8c2d2d586fd1bd29d05ea7fe8968894de",
//	  "recipient": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
//	}
type SolanaReservePrehash struct {
	// DepositHash is the hex-encoded 32-byte deposit hash (with 0x prefix).
	DepositHash string `json:"deposit_hash"`
	// Recipient is the Base58-encoded Solana public key of the settler.
	Recipient string `json:"recipient"`
}

// ToJSON serializes the prehash to JSON bytes.
func (p *SolanaReservePrehash) ToJSON() ([]byte, error) {
	return json.Marshal(p)
}

// ComputeReserveHash computes the reserve message hash under the frozen pre-quote-hash layout
// (signature_domain_version 1 and 2). The current program refuses it; use ComputeReserveHashV2 for
// domain versions 3 and 4 and ComputeReserveHashV3 from version 5.
//
// This hash must be signed by the reserver to authorize fund reservation for a specific settler.
//
// Hash formula (the program's layout at domain versions 1 and 2):
//
//	keccak256(
//	    "escrow" || version[1] || cluster_id[32] || program_id[32] ||
//	    "reserve" || recipient[32] || deposit_hash[32]
//	)
func ComputeReserveHash(params EscrowReserveParams, domain EscrowDomain) ([32]byte, error) {
	var zero32 [32]byte
	if params.DepositHash == zero32 {
		return zero32, ErrZeroDepositHash
	}

	if params.Recipient.IsZero() {
		return zero32, ErrZeroRecipient
	}

	prefix, err := EscrowDomainPrefixBytes(domain)
	if err != nil {
		return zero32, err
	}

	parts := append(prefix,
		[]byte("reserve"),
		params.Recipient[:],
		params.DepositHash[:],
	)

	return Keccak256(parts...), nil
}

// SolanaReservePrehashV2 is the message_prehash for the V2 reserve operation, which binds
// the offchain quote hash. It is additive — the V1
// SolanaReservePrehash above is unchanged. quote_hash is appended LAST so a verifier can
// re-derive keccak256(... || "reserve" || recipient || deposit_hash || quote_hash).
type SolanaReservePrehashV2 struct {
	// DepositHash is the hex-encoded 32-byte deposit hash (with 0x prefix).
	DepositHash string `json:"deposit_hash"`
	// Recipient is the Base58-encoded Solana public key of the settler.
	Recipient string `json:"recipient"`
	// QuoteHash is the hex-encoded 32-byte offchain quote hash (with 0x prefix).
	QuoteHash string `json:"quote_hash"`
}

// ToJSON serializes the V2 prehash to JSON bytes.
func (p *SolanaReservePrehashV2) ToJSON() ([]byte, error) {
	return json.Marshal(p)
}

// ComputeReserveHashV2 computes the V2 reserve message hash, binding the offchain quote hash
// (signature_domain_version 3 and 4). It is additive — ComputeReserveHash above is unchanged.
// The quote hash is appended LAST (the program's layout at domain versions 3 and 4):
//
//	keccak256(
//	    "escrow" || version[1] || cluster_id[32] || program_id[32] ||
//	    "reserve" || recipient[32] || deposit_hash[32] || quote_hash[32]
//	)
//
// The on-chain reserve rejects an empty quote_hash, so this does too. From domain version 5 the
// program also binds the charged source amount: use ComputeReserveHashV3.
func ComputeReserveHashV2(params EscrowReserveParams, quoteHash [32]byte, domain EscrowDomain) ([32]byte, error) {
	var zero32 [32]byte
	if params.DepositHash == zero32 {
		return zero32, ErrZeroDepositHash
	}
	if params.Recipient.IsZero() {
		return zero32, ErrZeroRecipient
	}
	if quoteHash == zero32 {
		return zero32, ErrZeroQuoteHash
	}

	prefix, err := EscrowDomainPrefixBytes(domain)
	if err != nil {
		return zero32, err
	}

	parts := append(prefix,
		[]byte("reserve"),
		params.Recipient[:],
		params.DepositHash[:],
		quoteHash[:],
	)

	return Keccak256(parts...), nil
}

// SolanaReservePrehashV3 is the message_prehash for the V3 reserve operation, which additionally
// binds source_amount — the amount the payer is ACTUALLY charged (Solana parity with the EVM ReserveWitness,
// which carries sourceAmount inside the signed struct). Additive: V1 and V2 above are unchanged.
//
// Why the charge belongs in the SIGNED prehash rather than beside it as a bare instruction
// argument: the depositor signs a ceiling at deposit time, before the auction picks a winner, so
// the charge can only be stated later. Whoever states it is deciding how much of the payer's
// authorization to consume, and that has to be the RESERVER (the quote selector) whose key this
// hash is verified against — otherwise the settler, the party being paid, would choose what the
// payer is charged, bounded only by the ceiling. EVM has the same property by putting
// `sourceAmount` inside the reserver-signed ReserveWitness.
type SolanaReservePrehashV3 struct {
	// DepositHash is the hex-encoded 32-byte deposit hash (with 0x prefix).
	DepositHash string `json:"deposit_hash"`
	// Recipient is the Base58-encoded Solana public key of the settler.
	Recipient string `json:"recipient"`
	// QuoteHash is the hex-encoded 32-byte offchain quote hash (with 0x prefix).
	QuoteHash string `json:"quote_hash"`
	// SourceAmount is the amount actually charged, as a base-10 string in the token's smallest
	// unit. A string, not a number: JSON numbers are float64 in most decoders and a u64 above
	// 2^53 loses precision silently, which for this field means signing one charge and settling
	// another.
	SourceAmount string `json:"source_amount"`
}

// ToJSON serializes the V3 prehash to JSON bytes.
func (p *SolanaReservePrehashV3) ToJSON() ([]byte, error) {
	return json.Marshal(p)
}

// ComputeReserveHashV3 computes the V3 reserve message hash, binding the charged source amount on
// top of V2's quote hash. Additive — V1/V2 above are unchanged.
//
// The source amount is appended LAST, as a little-endian u64 matching Rust's `to_le_bytes()`
// (Rust source: `compute_reserve_hash`):
//
//	keccak256(
//	    "escrow" || version[1] || cluster_id[32] || program_id[32] ||
//	    "reserve" || recipient[32] || deposit_hash[32] || quote_hash[32] || source_amount[8 LE]
//	)
//
// Requires signature_domain_version >= 5, read live from ProtocolConfig into EscrowDomain and
// never hardcoded. A zero source amount is rejected here because the on-chain reserve rejects it:
// releasing zero would consume the deposit and pay the settler nothing.
func ComputeReserveHashV3(
	params EscrowReserveParams,
	quoteHash [32]byte,
	sourceAmount uint64,
	domain EscrowDomain,
) ([32]byte, error) {
	var zero32 [32]byte
	if params.DepositHash == zero32 {
		return zero32, ErrZeroDepositHash
	}
	if params.Recipient.IsZero() {
		return zero32, ErrZeroRecipient
	}
	if quoteHash == zero32 {
		return zero32, ErrZeroQuoteHash
	}
	if sourceAmount == 0 {
		return zero32, ErrZeroSourceAmount
	}

	prefix, err := EscrowDomainPrefixBytes(domain)
	if err != nil {
		return zero32, err
	}

	parts := append(prefix,
		[]byte("reserve"),
		params.Recipient[:],
		params.DepositHash[:],
		quoteHash[:],
		EncodeU64LE(sourceAmount),
	)

	return Keccak256(parts...), nil
}
