package stellar_escrow_encoding

import "math/big"

// EscrowReserveParams contains the parameters needed to compute the reserve digest.
type EscrowReserveParams struct {
	// DepositID is the deposit digest returned by ComputeDepositHash.
	DepositID [32]byte

	// QuoteHash is the offchain quote hash the reserver selected.
	QuoteHash [32]byte

	// Settler is the account paid at release, named by the reserver, not the depositor.
	Settler Address

	// SourceAmount is the amount actually charged, 0 < SourceAmount <= the deposit's Amount.
	SourceAmount *big.Int
}

// CheckSourceAmount enforces `0 < source_amount <= amount`, the contract's rule across the two witnesses.
// ComputeReserveHash cannot, because the ceiling is not one of its inputs.
func CheckSourceAmount(ceiling, sourceAmount *big.Int) error {
	if _, err := EncodeAmount16(ceiling); err != nil {
		return err
	}
	if _, err := EncodeAmount16(sourceAmount); err != nil {
		return err
	}
	if sourceAmount.Sign() == 0 {
		return ErrZeroSourceAmount
	}
	if sourceAmount.Cmp(ceiling) > 0 {
		return ErrInvalidSourceAmount
	}
	return nil
}

// ComputeReserveHash computes the reserve digest.
//
// This digest is signed by the reserver (ed25519 over the 32 digest bytes). source_amount is inside the
// signature so the settler, who is paid, cannot choose what the depositor is charged.
//
// Hash formula (Rust source: `compute_reserve_hash`, 191 bytes):
//
//	keccak256(
//	    "escrow" || version[1] || network_id[32] || contract_id[32] ||
//	    "reserve" || deposit_id[32] || quote_hash[32] || settler[33] || source_amount[16,LE]
//	)
func ComputeReserveHash(params EscrowReserveParams, domain EscrowDomain) ([32]byte, error) {
	var zero32 [32]byte
	if params.DepositID == zero32 {
		return zero32, ErrZeroDepositID
	}
	if params.QuoteHash == zero32 {
		return zero32, ErrZeroQuoteHash
	}
	sourceAmount, err := EncodeAmount16(params.SourceAmount)
	if err != nil {
		return zero32, err
	}
	if params.SourceAmount.Sign() == 0 {
		return zero32, ErrZeroSourceAmount
	}
	if !params.Settler.valid() {
		return zero32, ErrUnsupportedAddress
	}

	settler := params.Settler.Bytes33()
	return hashWithDomain(domain, "reserve",
		params.DepositID[:],
		params.QuoteHash[:],
		settler[:],
		sourceAmount,
	)
}
