package encoding

import (
	"math/big"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"github.com/ethereum/go-ethereum/common"
)

// TestRefundWitnessV2TypeHash ties the V2 RefundWitness EIP-712 typehash to Escrow.sol's
// REFUND_WITNESS_TYPE_HASH, EXTRACTED FROM THE SOLIDITY SOURCE at test time. It hashes the encoder's
// ACTUAL Types map (EscrowRefundEncoder.BuildTypedDataWithQuoteHash) rather than a copy, so a member
// reordered, renamed, retyped, added, or dropped in the encoder fails here.
//
// CORE-1863: this test used to compare against a hardcoded
// 0xe8ca5e1b48fa7cb0064474808ac426a0e3c1f93b2ae9e887d3b0a5918b5cac54, documented as "the merged
// escrow contract's value". It was not. It was the keccak of THIS MODULE'S OWN stale NINE-field type
// string — depositRequestHash and destinationHash missing at positions 3-4 — while the contract pins
// the ELEVEN-field 0x3b5d88b2…. Encoder and expected value were wrong together, so they agreed and
// the suite went green over a signature shape that could never verify on-chain.
//
// The expected value now comes from the contract, so that failure mode is structurally impossible.
// See escrow_source_typehash_test.go for the scanner, its hardening, and its fail-closed proofs.
func TestRefundWitnessV2TypeHash(t *testing.T) {
	// big.Int fields must be non-nil — BuildTypedDataWithQuoteHash marshals them into Message.
	w := contracts.IEscrowRefundWitness{Amount: big.NewInt(0), FeeAmount: big.NewInt(0)}
	td := EscrowRefundEncoder{}.BuildTypedDataWithQuoteHash(common.Address{}, w, [32]byte{}, big.NewInt(1))

	assertWitnessTypeHashMatchesEscrowSource(t, "RefundWitness", "REFUND_WITNESS_TYPE_HASH", td)
}
