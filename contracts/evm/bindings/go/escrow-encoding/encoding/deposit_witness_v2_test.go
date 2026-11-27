package encoding

import (
	"fmt"
	"math/big"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// TestDepositWitnessV2TypeHash ties the V2 DepositWitness EIP-712 typehash to Escrow.sol's
// DEPOSIT_WITNESS_TYPE_HASH, EXTRACTED FROM THE SOLIDITY SOURCE at test time.
//
// NEW IN CORE-1863. Deposit was the only witness with no typehash test of any kind, and it was also
// the worst diverged: the V1 encoder declares a TWO-field DepositWitness {reserver, releaser}
// (keccak 0xbcc7a43f…) against the contract's FOUR-field 0x49bfb2c3…, and there was no V2 builder at
// all. witness.DepositRequestHash and witness.Destination were accepted by BuildTypedData and
// silently dropped, so the digest committed to neither the request nor the destination — the exact
// binding CORE-2120 exists to establish.
//
// TestDepositWitnessTypeStringMatchesPermit2FullTypeString covers the other half of the deposit
// contract: FULL_DEPOSIT_WITNESS_TYPE_STRING, the string Escrow.sol hands Permit2.
func TestDepositWitnessV2TypeHash(t *testing.T) {
	td := EscrowDepositEncoder{}.BuildTypedDataWithDestination(
		common.Address{}, common.Address{}, common.Address{},
		contracts.IEscrowDepositWitness{},
		big.NewInt(0), big.NewInt(0), big.NewInt(0), big.NewInt(1),
	)

	assertWitnessTypeHashMatchesEscrowSource(t, "DepositWitness", "DEPOSIT_WITNESS_TYPE_HASH", td)
}

// TestDepositWitnessV1TypeHashIsFrozen pins that V1's EIP-712 type is still the two-member
// {reserver, releaser} shape, so the digests produced against the currently deployed escrow do not
// move. It asserts that through the ONE remaining V1 path that will hash a four-member witness:
// BuildTypedData, the pure projection.
//
// It used to assert this through encoder.Digest, which meant the test's own fixture was the
// canonical example of the defect the reviewer of PR #49 flagged — a caller populating
// DepositRequestHash and Destination and getting a digest that commits to neither. Digest now
// rejects that witness (see TestDepositV1DigestRejectsDroppedCommitmentMembers), so the frozen-shape
// assertion moved down a layer to the builder, where "hashes only the two members it declares" is
// the intended, documented behaviour rather than a silent drop.
func TestDepositWitnessV1TypeHashIsFrozen(t *testing.T) {
	encoder := NewEscrowDepositEncoder()
	// apitypes.TypedDataAndHash over BuildTypedData is exactly what Digest does after its guard,
	// so this is the same hashing path with the caller-error check bypassed on purpose.
	v1Hash := func(w contracts.IEscrowDepositWitness) ([]byte, error) {
		hash, _, err := apitypes.TypedDataAndHash(encoder.BuildTypedData(
			common.Address{}, common.Address{}, common.Address{}, w,
			big.NewInt(1), big.NewInt(2), big.NewInt(3), big.NewInt(1),
		))
		return hash, err
	}

	bare := contracts.IEscrowDepositWitness{
		Reserver: common.HexToAddress("0x1111111111111111111111111111111111111111"),
		Releaser: common.HexToAddress("0x2222222222222222222222222222222222222222"),
	}
	committed := bare
	committed.DepositRequestHash = [32]byte{0xaa}
	committed.Destination = "eip155:8453/erc20:0xdead@0xbeef"

	bareDigest, err := v1Hash(bare)
	if err != nil {
		t.Fatalf("V1 typed-data hash (bare witness): %v", err)
	}
	committedDigest, err := v1Hash(committed)
	if err != nil {
		t.Fatalf("V1 typed-data hash (committed witness): %v", err)
	}

	if common.Bytes2Hex(bareDigest) != common.Bytes2Hex(committedDigest) {
		t.Fatalf("V1 deposit typed data changed when DepositRequestHash/Destination were populated "+
			"(%s vs %s). If V1 now commits to them its typehash moved, which breaks every signature "+
			"produced against the currently deployed escrow. V1 must stay the two-field shape; add to "+
			"BuildTypedDataWithDestination instead.",
			common.Bytes2Hex(bareDigest), common.Bytes2Hex(committedDigest))
	}

	// ...and the V2 builder must NOT share that blindness.
	v2Bare, _, err := encoder.DigestWithDestination(
		common.Address{}, common.Address{}, common.Address{}, bare,
		big.NewInt(1), big.NewInt(2), big.NewInt(3), big.NewInt(1),
	)
	if err != nil {
		t.Fatalf("V2 digest (bare witness): %v", err)
	}
	v2Committed, _, err := encoder.DigestWithDestination(
		common.Address{}, common.Address{}, common.Address{}, committed,
		big.NewInt(1), big.NewInt(2), big.NewInt(3), big.NewInt(1),
	)
	if err != nil {
		t.Fatalf("V2 digest (committed witness): %v", err)
	}
	if common.Bytes2Hex(v2Bare) == common.Bytes2Hex(v2Committed) {
		t.Fatalf("V2 deposit digest is INSENSITIVE to DepositRequestHash/Destination (%s) — the "+
			"destination commitment is not actually being hashed", common.Bytes2Hex(v2Bare))
	}
}

// The digest the TypeScript encoder is pinned to (deposit-encoder.test.ts), so both languages are
// held to the same bytes.
func TestDepositWithDestinationGolden(t *testing.T) {
	amount, _ := new(big.Int).SetString("1000000000000000000000", 10)
	witness := contracts.IEscrowDepositWitness{
		DepositRequestHash: crypto.Keccak256Hash([]byte("req-golden")),
		Destination:        "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979",
		Reserver:           common.HexToAddress("0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb"),
		Releaser:           common.HexToAddress("0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9"),
	}
	digest, _, err := EscrowDepositEncoder{}.DigestWithDestination(
		common.HexToAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
		common.HexToAddress("0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f"),
		common.HexToAddress("0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0"),
		witness, amount, big.NewInt(1), big.NewInt(1770395075), big.NewInt(1))
	if err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprintf("0x%x", digest); got != "0x3eba91739f468207bafeebfba019e10750b13dc5ad645a53d391bb8e778e8ff6" {
		t.Fatalf("digest = %s", got)
	}
}
