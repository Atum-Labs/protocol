package encoding

import (
	"math/big"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"github.com/ethereum/go-ethereum/common"
)

// TestReleaseWitnessV2TypeHash ties the V2 ReleaseWitness EIP-712 typehash to Escrow.sol's
// RELEASE_WITNESS_TYPE_HASH, EXTRACTED FROM THE SOLIDITY SOURCE at test time. It hashes the
// encoder's ACTUAL Types map (EscrowReleaseEncoder.BuildTypedDataWithQuoteHash) rather than a copy,
// so a member reordered, renamed, retyped, added, or dropped in the encoder fails here.
//
// CORE-1863: this test used to compare against a hardcoded
// 0xc005c3928cc96cbe4bcbd46100c95ac5fa1a7478589fe64ca40af795d7e6a62a, documented as "the merged
// escrow contract's value". It was not. It was the keccak of THIS MODULE'S OWN stale NINE-field type
// string — depositRequestHash and destinationHash missing at positions 3-4 — while the contract pins
// the ELEVEN-field 0x7b53386f…. Encoder and expected value were wrong together, so they agreed and
// the suite went green over a signature shape that could never verify on-chain.
//
// The expected value now comes from the contract, so that failure mode is structurally impossible.
// See escrow_source_typehash_test.go for the scanner, its hardening, and its fail-closed proofs.
func TestReleaseWitnessV2TypeHash(t *testing.T) {
	// big.Int fields must be non-nil — BuildTypedDataWithQuoteHash marshals them into Message.
	w := contracts.IEscrowReleaseWitness{Amount: big.NewInt(0), FeeAmount: big.NewInt(0)}
	td := EscrowReleaseEncoder{}.BuildTypedDataWithQuoteHash(common.Address{}, w, [32]byte{}, big.NewInt(1))

	assertWitnessTypeHashMatchesEscrowSource(t, "ReleaseWitness", "RELEASE_WITNESS_TYPE_HASH", td)
}
