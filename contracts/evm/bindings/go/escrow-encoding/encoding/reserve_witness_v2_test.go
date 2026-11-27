package encoding

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// TestReserveWitnessV2TypeHash ties the V2 ReserveWitness EIP-712 typehash (quoteHash +
// sourceAmount) to Escrow.sol's RESERVE_WITNESS_TYPE_HASH, EXTRACTED FROM THE SOLIDITY SOURCE at
// test time. It hashes the encoder's ACTUAL Types map
// (EscrowReserveEncoder.BuildTypedDataWithQuoteSource) rather than a copy of it, so a member
// reordered, renamed, retyped, added, or dropped in the encoder fails here — the signing-side
// analogue of the event-topic0 fixture.
//
// CORE-1863: the hardcoded expectation this replaces held the RIGHT value
// (0x231586e0…, matching the contract), which is exactly why the mechanism was worth changing anyway.
// Reserve was the one witness of four whose encoder agreed with Escrow.sol; release, refund, and
// deposit did not, and their identical-looking hardcoded pins reported green regardless. A pin whose
// expected value is transcribed by hand is correct only until someone transcribes the next one.
func TestReserveWitnessV2TypeHash(t *testing.T) {
	td := EscrowReserveEncoder{}.BuildTypedDataWithQuoteSource(
		common.Address{}, [32]byte{}, [32]byte{}, common.Address{}, big.NewInt(0), big.NewInt(1))

	assertWitnessTypeHashMatchesEscrowSource(t, "ReserveWitness", "RESERVE_WITNESS_TYPE_HASH", td)
}
