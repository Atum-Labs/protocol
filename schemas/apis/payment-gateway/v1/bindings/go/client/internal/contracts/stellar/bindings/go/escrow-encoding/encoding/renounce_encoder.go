package stellar_escrow_encoding

// EscrowRenounceParams contains the parameters needed to compute the delegate renounce digest.
type EscrowRenounceParams struct {
	Depositor Address
	Token     Address

	// Epoch is the epoch of the delegate record being renounced: 1 for the first record of the
	// (depositor, token), +1 for each re-creation, kept across revokes. It binds the signature to one
	// record, so it cannot kill a later record of the same pair.
	Epoch uint64

	// Nonce comes from the depositor's nonce bitmap, so the signature is single-use.
	Nonce uint64

	// Deadline is a unix time in seconds. The contract refuses the renounce once its ledger time is past
	// it, so a signature that leaks unused stops working. The signer picks it; there is no upper bound.
	Deadline uint64
}

// ComputeRenounceHash computes the digest the delegate signer signs to give up its authority
// (`renounce_delegate`; ed25519 over the 32 digest bytes).
//
// Hash formula (Rust source: `compute_renounce_hash`, 169 bytes):
//
//	keccak256(
//	    "escrow" || version[1] || network_id[32] || contract_id[32] ||
//	    "renounce" || depositor[33] || token[33] || epoch[8,LE] || nonce[8,LE] || deadline[8,LE]
//	)
func ComputeRenounceHash(params EscrowRenounceParams, domain EscrowDomain) ([32]byte, error) {
	if !params.Depositor.valid() || !params.Token.valid() {
		return [32]byte{}, ErrUnsupportedAddress
	}
	depositor, token := params.Depositor.Bytes33(), params.Token.Bytes33()
	return hashWithDomain(domain, "renounce",
		depositor[:],
		token[:],
		EncodeU64LE(params.Epoch),
		EncodeU64LE(params.Nonce),
		EncodeU64LE(params.Deadline),
	)
}
