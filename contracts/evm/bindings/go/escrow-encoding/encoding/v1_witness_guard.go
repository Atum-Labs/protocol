package encoding

import (
	"errors"
	"fmt"
	"math/big"
	"strings"

	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"github.com/ethereum/go-ethereum/common"
)

// The base Digest / DigestWithTypedData methods hash only the members their EIP-712 Types maps
// declare, which is fewer than the generated witness structs carry (DepositRequestHash and
// Destination on the deposit witness; QuoteHash, DepositRequestHash and DestinationHash on
// release/refund; QuoteHash and SourceAmount on reserve). A populated undeclared member would be
// silently left out of the digest, so these guards reject it with ErrV1WitnessDropsMembers,
// naming the member and the method that does hash it. A zero value means "not supplied", the
// same rule DigestWithQuoteHash uses for its witness.QuoteHash conflict check.
//
// BuildTypedData returns no error and stays a plain projection; the digest methods are where a
// witness becomes signable, so they are where it is refused.

// ErrV1WitnessDropsMembers is wrapped by every dropped-member rejection, so callers can match it
// with errors.Is.
var ErrV1WitnessDropsMembers = errors.New(
	"witness members populated that the frozen V1 EIP-712 type does not hash")

// v1DroppedMembersError builds the rejection. witnessName is the EIP-712 struct name, v2Method is
// the method that hashes the dropped members, and dropped lists them as "name=value".
func v1DroppedMembersError(witnessName, v2Method string, dropped []string) error {
	return fmt.Errorf(
		"%w: %s V1 declares no %s, so this digest would commit to none of them while the caller "+
			"believes it does. Use %s for the redeployed escrow, or leave the member(s) zero to sign "+
			"the frozen V1 shape deliberately. Populated: %s",
		ErrV1WitnessDropsMembers, witnessName, strings.Join(memberNames(dropped), ", "), v2Method,
		strings.Join(dropped, " "))
}

// memberNames strips the "=value" tail so the leading sentence lists bare member names.
func memberNames(dropped []string) []string {
	out := make([]string, 0, len(dropped))
	for _, d := range dropped {
		name, _, _ := strings.Cut(d, "=")
		out = append(out, name)
	}
	return out
}

// nonZeroHash reports whether a bytes32 member was populated.
func nonZeroHash(v [32]byte) bool { return v != ([32]byte{}) }

// nonZeroAmount reports whether a *big.Int member was populated; nil and 0 both mean
// "not supplied".
func nonZeroAmount(v *big.Int) bool { return v != nil && v.Sign() != 0 }

// assertDepositWitnessV1Complete rejects a deposit witness carrying either destination commitment.
func assertDepositWitnessV1Complete(w contracts.IEscrowDepositWitness) error {
	var dropped []string
	if nonZeroHash(w.DepositRequestHash) {
		dropped = append(dropped,
			"depositRequestHash="+common.BytesToHash(w.DepositRequestHash[:]).Hex())
	}
	if w.Destination != "" {
		dropped = append(dropped, "destination="+w.Destination)
	}
	if len(dropped) == 0 {
		return nil
	}
	return v1DroppedMembersError("DepositWitness",
		"DigestWithDestination / BuildTypedDataWithDestination", dropped)
}

// assertReleaseWitnessV1Complete rejects a release witness carrying any of the three members the
// base eight-member ReleaseWitness type does not declare.
func assertReleaseWitnessV1Complete(w contracts.IEscrowReleaseWitness) error {
	dropped := droppedSettlementMembers(w.QuoteHash, w.DepositRequestHash, w.DestinationHash)
	if len(dropped) == 0 {
		return nil
	}
	return v1DroppedMembersError("ReleaseWitness",
		"DigestWithQuoteHash / BuildTypedDataWithQuoteHash", dropped)
}

// assertRefundWitnessV1Complete is assertReleaseWitnessV1Complete for the refund witness, which
// has the same member split.
func assertRefundWitnessV1Complete(w contracts.IEscrowRefundWitness) error {
	dropped := droppedSettlementMembers(w.QuoteHash, w.DepositRequestHash, w.DestinationHash)
	if len(dropped) == 0 {
		return nil
	}
	return v1DroppedMembersError("RefundWitness",
		"DigestWithQuoteHash / BuildTypedDataWithQuoteHash", dropped)
}

// assertReserveWitnessV1Complete rejects a reserve witness carrying the quote binding
// (QuoteHash, SourceAmount) the base ReserveWitness type does not declare.
func assertReserveWitnessV1Complete(w contracts.IEscrowReserveWitness) error {
	var dropped []string
	if nonZeroHash(w.QuoteHash) {
		dropped = append(dropped, "quoteHash="+common.BytesToHash(w.QuoteHash[:]).Hex())
	}
	if nonZeroAmount(w.SourceAmount) {
		dropped = append(dropped, "sourceAmount="+w.SourceAmount.String())
	}
	if len(dropped) == 0 {
		return nil
	}
	return v1DroppedMembersError("ReserveWitness",
		"DigestWithQuoteSource / BuildTypedDataWithQuoteSource", dropped)
}

// droppedSettlementMembers is the member scan shared by release and refund.
func droppedSettlementMembers(quoteHash, depositRequestHash, destinationHash [32]byte) []string {
	var dropped []string
	if nonZeroHash(quoteHash) {
		dropped = append(dropped, "quoteHash="+common.BytesToHash(quoteHash[:]).Hex())
	}
	if nonZeroHash(depositRequestHash) {
		dropped = append(dropped,
			"depositRequestHash="+common.BytesToHash(depositRequestHash[:]).Hex())
	}
	if nonZeroHash(destinationHash) {
		dropped = append(dropped, "destinationHash="+common.BytesToHash(destinationHash[:]).Hex())
	}
	return dropped
}
