package svm_escrow_encoding

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// BuildReserveWitness computes the V3 reserve hash and produces the prehash JSON
// for a Solana escrow reserve authorization.
//
// This is the canonical way to produce a reserve witness in Go. It encapsulates:
//  1. Computing the reserve hash via ComputeReserveHash with the supplied domain
//  2. Serializing the pre-image inputs as structured JSON (prehash)
//
// The caller only needs to sign the returned reserveHash and assemble the
// SignedMessage using both the hash and prehashJSON.
//
// Returns:
//   - reserveHash: V3 keccak256(domain_prefix || "reserve" || recipient || depositHash) — to be signed
//   - prehashJSON: JSON string documenting the inputs — for message_prehash field
//   - error: if inputs are invalid (zero values)
func BuildReserveWitness(depositHash [32]byte, recipient Pubkey, domain EscrowDomain) ([32]byte, string, error) {
	var zero32 [32]byte

	reserveHash, err := ComputeReserveHash(EscrowReserveParams{
		DepositHash: depositHash,
		Recipient:   recipient,
	}, domain)
	if err != nil {
		return zero32, "", fmt.Errorf("compute reserve hash: %w", err)
	}

	// Build the prehash JSON documenting the inputs
	prehash := SolanaReservePrehash{
		DepositHash: "0x" + fmt.Sprintf("%x", depositHash[:]),
		Recipient:   recipient.String(),
	}

	prehashBytes, err := json.Marshal(prehash)
	if err != nil {
		return zero32, "", fmt.Errorf("marshal reserve prehash: %w", err)
	}

	return reserveHash, string(prehashBytes), nil
}

// BuildReserveWitnessV2 is the quote-hash sibling of BuildReserveWitness: it binds the
// offchain quote hash into the reserve authorization (veri-fill trust model, solana-escrow
// #15). It is additive — BuildReserveWitness above is byte-unchanged. The returned prehash
// JSON documents quote_hash so any verifier can independently re-compute the V2 reserve hash.
//
// Returns:
//   - reserveHash: V2 keccak256(domain_prefix || "reserve" || recipient || depositHash || quoteHash) — to be signed
//   - prehashJSON: JSON string documenting the inputs (incl. quote_hash) — for message_prehash
//   - error: if inputs are invalid (zero deposit hash / recipient / quote hash)
func BuildReserveWitnessV2(depositHash [32]byte, recipient Pubkey, quoteHash [32]byte, domain EscrowDomain) ([32]byte, string, error) {
	var zero32 [32]byte

	reserveHash, err := ComputeReserveHashV2(EscrowReserveParams{
		DepositHash: depositHash,
		Recipient:   recipient,
	}, quoteHash, domain)
	if err != nil {
		return zero32, "", fmt.Errorf("compute reserve hash v2: %w", err)
	}

	prehash := SolanaReservePrehashV2{
		DepositHash: "0x" + fmt.Sprintf("%x", depositHash[:]),
		Recipient:   recipient.String(),
		QuoteHash:   "0x" + fmt.Sprintf("%x", quoteHash[:]),
	}

	prehashBytes, err := json.Marshal(prehash)
	if err != nil {
		return zero32, "", fmt.Errorf("marshal reserve prehash v2: %w", err)
	}

	return reserveHash, string(prehashBytes), nil
}

// BuildReserveWitnessV3 is the Solana-parity sibling of BuildReserveWitnessV2: it
// additionally binds the charged source amount into the reserve authorization. It is
// additive — V1 and V2 above are byte-unchanged.
//
// This is the wrapper payment-gw calls, so it is the seam where the charge actually enters the
// signed material. The reserver signs it because the depositor signed only a CEILING at deposit
// time (before the auction ran), so stating the charge decides how much of that authorization to
// consume — and the settler, the party being paid, must not be the one deciding that.
//
// Requires signature_domain_version >= 5.
//
// Returns:
//   - reserveHash: V3 keccak256(domain_prefix || "reserve" || recipient || depositHash || quoteHash || sourceAmount[8 LE]) — to be signed
//   - prehashJSON: JSON documenting the inputs (incl. quote_hash and source_amount) — for message_prehash
//   - error: if inputs are invalid (zero deposit hash / recipient / quote hash / source amount)
func BuildReserveWitnessV3(
	depositHash [32]byte,
	recipient Pubkey,
	quoteHash [32]byte,
	sourceAmount uint64,
	domain EscrowDomain,
) ([32]byte, string, error) {
	var zero32 [32]byte

	reserveHash, err := ComputeReserveHashV3(EscrowReserveParams{
		DepositHash: depositHash,
		Recipient:   recipient,
	}, quoteHash, sourceAmount, domain)
	if err != nil {
		return zero32, "", fmt.Errorf("compute reserve hash v3: %w", err)
	}

	prehash := SolanaReservePrehashV3{
		DepositHash: "0x" + fmt.Sprintf("%x", depositHash[:]),
		Recipient:   recipient.String(),
		QuoteHash:   "0x" + fmt.Sprintf("%x", quoteHash[:]),
		// Decimal string, not a JSON number: the settler reads this back to rebuild the
		// instruction argument, and a u64 above 2^53 would lose precision through a float64
		// decoder — signing one charge and submitting another.
		SourceAmount: strconv.FormatUint(sourceAmount, 10),
	}

	prehashBytes, err := json.Marshal(prehash)
	if err != nil {
		return zero32, "", fmt.Errorf("marshal reserve prehash v3: %w", err)
	}

	return reserveHash, string(prehashBytes), nil
}
