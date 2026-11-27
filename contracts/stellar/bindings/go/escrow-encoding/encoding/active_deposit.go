package stellar_escrow_encoding

import "math/big"

// EscrowActiveDeposit is the ten-member tuple the escrow stores a hash of while a deposit is live, in
// EVM's ActiveDeposit order. Release and refund rebuild it from their witness and compare.
type EscrowActiveDeposit struct {
	Depositor          Address
	QuoteHash          [32]byte
	DepositRequestHash [32]byte
	// DestinationHash is keccak256(destination), as ComputeDestinationHash returns it.
	DestinationHash [32]byte
	Token           Address
	// Amount is the stored amount, equal to the reserve's source_amount.
	Amount *big.Int
	// FeeAmount is the fee fixed at deposit, taken at release only.
	FeeAmount *big.Int
	Reserver  Pubkey
	Releaser  Pubkey
	Settler   Address
}

// ComputeActiveDepositHash computes what `get_deposit_hash(deposit_id)` returns. It is stored, not signed:
// there is no domain prefix and no tag, because it never leaves the contract's storage.
//
// Hash formula (Rust source: `compute_active_deposit_hash`, 291 bytes):
//
//	keccak256(
//	    depositor[33] || quote_hash[32] || deposit_request_hash[32] || destination_hash[32] ||
//	    token[33] || amount[16,LE] || fee_amount[16,LE] || reserver[32] || releaser[32] || settler[33]
//	)
//
// A client can compare it with the on-chain value to know a release or refund witness will be accepted
// before paying for the transaction.
func ComputeActiveDepositHash(d EscrowActiveDeposit) ([32]byte, error) {
	e, err := d.encode()
	if err != nil {
		return [32]byte{}, err
	}
	return Keccak256(
		e.depositor[:],
		d.QuoteHash[:],
		d.DepositRequestHash[:],
		d.DestinationHash[:],
		e.token[:],
		e.amount,
		e.fee,
		d.Reserver[:],
		d.Releaser[:],
		e.settler[:],
	), nil
}

// encodedDeposit holds the members whose wire form is not their Go value.
type encodedDeposit struct {
	depositor, token, settler [33]byte
	amount, fee               []byte
}

// encode validates the amounts and address types and returns the fixed-width forms.
func (d EscrowActiveDeposit) encode() (encodedDeposit, error) {
	amount, err := EncodeAmount16(d.Amount)
	if err != nil {
		return encodedDeposit{}, err
	}
	fee, err := EncodeAmount16(d.FeeAmount)
	if err != nil {
		return encodedDeposit{}, err
	}
	if !d.Depositor.valid() || !d.Token.valid() || !d.Settler.valid() {
		return encodedDeposit{}, ErrUnsupportedAddress
	}
	return encodedDeposit{
		depositor: d.Depositor.Bytes33(),
		token:     d.Token.Bytes33(),
		settler:   d.Settler.Bytes33(),
		amount:    amount,
		fee:       fee,
	}, nil
}
