package encoding

import (
	"bytes"
	"math/big"
	"strings"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/generated"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// witness_v2_typehash_test.go proves the V2 Types maps declare the members Escrow.sol expects. That
// is necessary and NOT sufficient: a Types map can declare `depositRequestHash` while the Message map
// feeds it a constant, and every typehash pin still passes because a typehash is derived from the TYPE
// only. The digest would then be identical for two different deposit requests — the signature would
// verify on-chain and authorise the wrong one.
//
// So these tests assert the other half: each newly added member is actually BOUND to the value the
// caller supplied. Change one member, the digest must move.

var (
	witnessValueA = [32]byte{0x11}
	witnessValueB = [32]byte{0x22}
)

func releaseV2Digest(t *testing.T, w contracts.IEscrowReleaseWitness, quoteHash [32]byte) []byte {
	t.Helper()
	w.Amount, w.FeeAmount = big.NewInt(1), big.NewInt(2)
	digest, _, err := EscrowReleaseEncoder{}.DigestWithQuoteHash(common.Address{}, w, quoteHash, big.NewInt(shastaChainID))
	if err != nil {
		t.Fatalf("DigestWithQuoteHash: %v", err)
	}
	return digest
}

func refundV2Digest(t *testing.T, w contracts.IEscrowRefundWitness, quoteHash [32]byte) []byte {
	t.Helper()
	w.Amount, w.FeeAmount = big.NewInt(1), big.NewInt(2)
	digest, _, err := EscrowRefundEncoder{}.DigestWithQuoteHash(common.Address{}, w, quoteHash, big.NewInt(shastaChainID))
	if err != nil {
		t.Fatalf("DigestWithQuoteHash: %v", err)
	}
	return digest
}

func TestReleaseV2DigestBindsEveryNewMember(t *testing.T) {
	base := releaseV2Digest(t, contracts.IEscrowReleaseWitness{}, [32]byte{})

	for _, tc := range []struct {
		member  string
		witness contracts.IEscrowReleaseWitness
	}{
		{"depositRequestHash", contracts.IEscrowReleaseWitness{DepositRequestHash: witnessValueA}},
		{"destinationHash", contracts.IEscrowReleaseWitness{DestinationHash: witnessValueA}},
	} {
		t.Run(tc.member, func(t *testing.T) {
			if got := releaseV2Digest(t, tc.witness, [32]byte{}); bytes.Equal(got, base) {
				t.Fatalf("changing witness.%s did not change the release V2 digest (%#x): the member is declared "+
					"in the Types map but its value is NOT bound into Message, so two different releases share a "+
					"digest and one signature authorises both", tc.member, got)
			}
		})
	}

	t.Run("quoteHash", func(t *testing.T) {
		if got := releaseV2Digest(t, contracts.IEscrowReleaseWitness{}, witnessValueA); bytes.Equal(got, base) {
			t.Fatalf("changing the quoteHash argument did not change the release V2 digest (%#x)", got)
		}
	})
}

func TestRefundV2DigestBindsEveryNewMember(t *testing.T) {
	base := refundV2Digest(t, contracts.IEscrowRefundWitness{}, [32]byte{})

	for _, tc := range []struct {
		member  string
		witness contracts.IEscrowRefundWitness
	}{
		{"depositRequestHash", contracts.IEscrowRefundWitness{DepositRequestHash: witnessValueA}},
		{"destinationHash", contracts.IEscrowRefundWitness{DestinationHash: witnessValueA}},
	} {
		t.Run(tc.member, func(t *testing.T) {
			if got := refundV2Digest(t, tc.witness, [32]byte{}); bytes.Equal(got, base) {
				t.Fatalf("changing witness.%s did not change the refund V2 digest (%#x): the member is declared "+
					"in the Types map but its value is NOT bound into Message", tc.member, got)
			}
		})
	}
}

// TestReleaseAndRefundV2DigestsDifferForIdenticalWitnesses is a domain-separation check the V1 suite
// has no analogue for. Release and refund carry ELEVEN identically-typed members in the same order and
// share the escrow's TIP-712 domain, so the ONLY thing keeping a releaser's signature from being
// replayable as a refund authorisation (and vice versa) is the differing type NAME inside the
// typehash. If a copy-paste ever set the refund builder's PrimaryType to "ReleaseWitness", every
// typehash pin above would still pass — TestRefundWitnessV2TypeHash asks about the "RefundWitness"
// entry, not about which entry the builder actually hashes.
func TestReleaseAndRefundV2DigestsDifferForIdenticalWitnesses(t *testing.T) {
	release := releaseV2Digest(t, contracts.IEscrowReleaseWitness{
		DepositId: witnessValueA, DepositRequestHash: witnessValueB, DestinationHash: witnessValueA,
	}, witnessValueB)
	refund := refundV2Digest(t, contracts.IEscrowRefundWitness{
		DepositId: witnessValueA, DepositRequestHash: witnessValueB, DestinationHash: witnessValueA,
	}, witnessValueB)

	if bytes.Equal(release, refund) {
		t.Fatalf("release and refund V2 digests are IDENTICAL for the same witness values (%#x): one "+
			"signature would authorise both operations. The two builders must hash different primary types.", release)
	}
}

// TestDigestWithQuoteHashRefusesAConflictingWitnessQuoteHash covers the guard added alongside the
// eleven-member fix. Escrow.sol hashes releaseWitness.quoteHash, so signing the loose argument instead
// would produce a signature that recovers to the wrong signer.
func TestDigestWithQuoteHashRefusesAConflictingWitnessQuoteHash(t *testing.T) {
	w := contracts.IEscrowReleaseWitness{QuoteHash: witnessValueA, Amount: big.NewInt(1), FeeAmount: big.NewInt(2)}
	if _, _, err := (EscrowReleaseEncoder{}).DigestWithQuoteHash(
		common.Address{}, w, witnessValueB, big.NewInt(shastaChainID)); err == nil {
		t.Error("release: expected a conflicting witness QuoteHash to be refused, got no error")
	}

	r := contracts.IEscrowRefundWitness{QuoteHash: witnessValueA, Amount: big.NewInt(1), FeeAmount: big.NewInt(2)}
	if _, _, err := (EscrowRefundEncoder{}).DigestWithQuoteHash(
		common.Address{}, r, witnessValueB, big.NewInt(shastaChainID)); err == nil {
		t.Error("refund: expected a conflicting witness QuoteHash to be refused, got no error")
	}

	// An AGREEING witness QuoteHash is the normal post-binding-regen call and must be accepted.
	agreeing := contracts.IEscrowReleaseWitness{QuoteHash: witnessValueA, Amount: big.NewInt(1), FeeAmount: big.NewInt(2)}
	if _, _, err := (EscrowReleaseEncoder{}).DigestWithQuoteHash(
		common.Address{}, agreeing, witnessValueA, big.NewInt(shastaChainID)); err != nil {
		t.Errorf("release: a witness QuoteHash equal to the argument must be accepted, got: %v", err)
	}
}

func TestDepositV2DigestBindsEveryNewMember(t *testing.T) {
	digest := func(w contracts.IEscrowDepositWitness) []byte {
		t.Helper()
		d, _, err := EscrowDepositEncoder{}.DigestWithDestination(
			common.Address{}, common.Address{}, common.Address{}, w,
			big.NewInt(1), big.NewInt(2), big.NewInt(3), big.NewInt(shastaChainID))
		if err != nil {
			t.Fatalf("DigestWithDestination: %v", err)
		}
		return d
	}

	base := digest(contracts.IEscrowDepositWitness{Destination: "eip155:1:0xabc"})

	if got := digest(contracts.IEscrowDepositWitness{
		Destination: "eip155:1:0xabc", DepositRequestHash: witnessValueA,
	}); bytes.Equal(got, base) {
		t.Errorf("changing witness.DepositRequestHash did not change the deposit V2 digest (%#x)", got)
	}
	if got := digest(contracts.IEscrowDepositWitness{
		Destination: "eip155:1:0xdef",
	}); bytes.Equal(got, base) {
		t.Errorf("changing witness.Destination did not change the deposit V2 digest (%#x): the destination is "+
			"the depositor's commitment to where the funds go, and an unbound one means one signature authorises "+
			"payment to ANY destination", got)
	}
}

// TestDepositV2DigestDiffersFromV1 is the whole point of the V2 builder existing separately: the two
// witness type strings hash differently, so the digests must differ for identical inputs. If they ever
// matched, one of the two builders would be encoding the other's shape.
func TestDepositV2DigestDiffersFromV1(t *testing.T) {
	w := contracts.IEscrowDepositWitness{
		DepositRequestHash: witnessValueA,
		Destination:        "eip155:1:0xabc",
		Reserver:           common.HexToAddress("0x1111111111111111111111111111111111111111"),
		Releaser:           common.HexToAddress("0x2222222222222222222222222222222222222222"),
	}
	args := []*big.Int{big.NewInt(1), big.NewInt(2), big.NewInt(3), big.NewInt(shastaChainID)}

	v1, err := EscrowDepositEncoder{}.Digest(
		common.Address{}, common.Address{}, common.Address{}, w, args[0], args[1], args[2], args[3])
	if err != nil {
		t.Fatalf("V1 Digest: %v", err)
	}
	v2, _, err := EscrowDepositEncoder{}.DigestWithDestination(
		common.Address{}, common.Address{}, common.Address{}, w, args[0], args[1], args[2], args[3])
	if err != nil {
		t.Fatalf("V2 DigestWithDestination: %v", err)
	}

	if bytes.Equal(v1, v2) {
		t.Fatalf("the V1 and V2 deposit digests are identical (%#x), so one builder is encoding the other's "+
			"witness shape — they hash different type strings (0xbcc7a43f… vs 0x49bfb2c3…) and cannot agree", v1)
	}
}

// TestDigestWithDestinationEnforcesTheContractsDestinationBounds mirrors Escrow.sol's
// DestinationCannotBeEmpty and DestinationTooLong reverts. keccak256("") is a valid bytes32, so an
// unset destination would otherwise be committed silently rather than failing.
func TestDigestWithDestinationEnforcesTheContractsDestinationBounds(t *testing.T) {
	digest := func(destination string) error {
		t.Helper()
		_, _, err := EscrowDepositEncoder{}.DigestWithDestination(
			common.Address{}, common.Address{}, common.Address{},
			contracts.IEscrowDepositWitness{DepositRequestHash: witnessValueA, Destination: destination},
			big.NewInt(1), big.NewInt(2), big.NewInt(3), big.NewInt(shastaChainID))
		return err
	}

	if err := digest(""); err == nil {
		t.Error("empty Destination: expected a refusal (contract reverts DestinationCannotBeEmpty), got no error")
	}
	if err := digest(strings.Repeat("a", MaxDestinationBytes+1)); err == nil {
		t.Error("over-long Destination: expected a refusal (contract reverts DestinationTooLong), got no error")
	}
	if err := digest(strings.Repeat("a", MaxDestinationBytes)); err != nil {
		t.Errorf("a Destination of exactly MAX_DESTINATION_BYTES is valid on-chain and must be accepted: %v", err)
	}
	// The bound is on BYTES, matching Solidity's bytes(destination).length — not on runes.
	if err := digest(strings.Repeat("é", MaxDestinationBytes)); err == nil {
		t.Errorf("a %d-rune / %d-byte Destination must be refused: the contract measures bytes",
			MaxDestinationBytes, len(strings.Repeat("é", MaxDestinationBytes)))
	}
}

// TestMaxDestinationBytesMatchesEscrowSource keeps the Go bound in lockstep with the contract's own
// MAX_DESTINATION_BYTES by EXTRACTING it, rather than trusting a transcribed 256.
func TestMaxDestinationBytesMatchesEscrowSource(t *testing.T) {
	declarations, value := findDeclaredUintConstant(escrowSourceCode(t), "MAX_DESTINATION_BYTES")
	if declarations != 1 {
		t.Fatalf("expected EXACTLY ONE `constant MAX_DESTINATION_BYTES = <decimal>;` declaration in %s, found %d",
			escrowSourcePath, declarations)
	}
	if value != MaxDestinationBytes {
		t.Fatalf("MaxDestinationBytes = %d but %s declares MAX_DESTINATION_BYTES = %d: DigestWithDestination "+
			"would accept a destination the contract reverts on (or reject one it allows)",
			MaxDestinationBytes, escrowSourcePath, value)
	}
}

// TestV1BuildersStillEmitPaymentIdAndTheirFrozenShapes guards the redeploy invariant from the other
// side. Every V2 change in this package is additive, and V1 must keep emitting the shapes the
// CURRENTLY DEPLOYED escrow verifies — including the member name `paymentId`, which CORE-2117 renamed
// to `depositId` in V2 only. Renaming one member name silently moves a frozen typehash and invalidates
// every signature already in flight.
func TestV1BuildersStillEmitPaymentIdAndTheirFrozenShapes(t *testing.T) {
	release := EscrowReleaseEncoder{}.BuildTypedData(common.Address{},
		contracts.IEscrowReleaseWitness{Amount: big.NewInt(0), FeeAmount: big.NewInt(0)}, big.NewInt(shastaChainID))
	refund := EscrowRefundEncoder{}.BuildTypedData(common.Address{},
		contracts.IEscrowRefundWitness{Amount: big.NewInt(0), FeeAmount: big.NewInt(0)}, big.NewInt(shastaChainID))
	reserve := EscrowReserveEncoder{}.BuildTypedData(common.Address{},
		contracts.IEscrowReserveWitness{}, big.NewInt(shastaChainID))
	deposit := EscrowDepositEncoder{}.BuildTypedData(common.Address{}, common.Address{}, common.Address{},
		contracts.IEscrowDepositWitness{}, big.NewInt(0), big.NewInt(0), big.NewInt(0), big.NewInt(shastaChainID))

	for _, tc := range []struct {
		td       apitypes.TypedData
		primary  string
		wantType string
	}{
		{
			td:      release,
			primary: "ReleaseWitness",
			wantType: "ReleaseWitness(bytes32 paymentId,address depositor,address token,uint256 amount," +
				"uint256 feeAmount,address reserver,address releaser,address settler)",
		},
		{
			td:      refund,
			primary: "RefundWitness",
			wantType: "RefundWitness(bytes32 paymentId,address depositor,address token,uint256 amount," +
				"uint256 feeAmount,address reserver,address releaser,address settler)",
		},
		{td: reserve, primary: "ReserveWitness", wantType: "ReserveWitness(bytes32 paymentId,address settler)"},
		{td: deposit, primary: "DepositWitness", wantType: "DepositWitness(address reserver,address releaser)"},
	} {
		t.Run(tc.primary, func(t *testing.T) {
			if got := string(tc.td.EncodeType(tc.primary)); got != tc.wantType {
				t.Errorf("V1 %s type string MOVED — pre-redeploy signatures would stop verifying:\n got: %s\nwant: %s",
					tc.primary, got, tc.wantType)
			}
		})
	}
}
