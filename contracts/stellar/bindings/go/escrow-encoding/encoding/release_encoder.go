package stellar_escrow_encoding

// EscrowSettlementParams contains the parameters needed to compute a release or refund digest: the
// deposit id and the eleven-member witness (the id plus the ten stored members), in the EVM
// ReleaseWitness / RefundWitness order.
type EscrowSettlementParams struct {
	// DepositID is the deposit digest returned by ComputeDepositHash.
	DepositID [32]byte

	EscrowActiveDeposit
}

// EscrowReleaseParams contains the parameters needed to compute a release message hash.
type EscrowReleaseParams = EscrowSettlementParams

// ComputeReleaseHash computes the release digest.
//
// This digest is signed by the releaser (member 10, as on EVM; ed25519 over the 32 digest bytes) to pay
// the settler `amount - fee_amount` and book the fee. Release and refund differ only in the tag, so a
// release signature can never validate as a refund.
//
// Hash formula (Rust source: `compute_release_hash`, 401 bytes):
//
//	keccak256(
//	    "escrow" || version[1] || network_id[32] || contract_id[32] ||
//	    "release" || deposit_id[32] || quote_hash[32] || deposit_request_hash[32] || destination_hash[32] ||
//	    depositor[33] || token[33] || amount[16,LE] || fee_amount[16,LE] ||
//	    reserver[32] || releaser[32] || settler[33]
//	)
func ComputeReleaseHash(params EscrowReleaseParams, domain EscrowDomain) ([32]byte, error) {
	return settlementHash(params, "release", domain)
}

// settlementHash is shared by release and refund, which differ only in the tag. Unlike Solana, the
// Soroban release and refund both reject a zero quote hash (QuoteHashCannotBeEmpty).
func settlementHash(params EscrowSettlementParams, tag string, domain EscrowDomain) ([32]byte, error) {
	var zero32 [32]byte
	if params.QuoteHash == zero32 {
		return zero32, ErrZeroQuoteHash
	}
	if params.DepositID == zero32 {
		return zero32, ErrZeroDepositID
	}
	e, err := params.encode()
	if err != nil {
		return zero32, err
	}
	return hashWithDomain(domain, tag,
		params.DepositID[:],
		params.QuoteHash[:],
		params.DepositRequestHash[:],
		params.DestinationHash[:],
		e.depositor[:],
		e.token[:],
		e.amount,
		e.fee,
		params.Reserver[:],
		params.Releaser[:],
		e.settler[:],
	)
}
