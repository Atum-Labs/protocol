package encoding

import (
	"errors"
	"math/big"
	"strings"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"github.com/ethereum/go-ethereum/common"
)

// Every V1 encoder's binding struct is now WIDER than its frozen EIP-712 Types map, because the
// bindings were regenerated for the redeployed escrow while V1 stayed byte-for-byte frozen:
//
//	DepositWitness  binding 4 members, V1 hashes 2  (drops depositRequestHash, destination)
//	ReleaseWitness  binding 11,        V1 hashes 8  (drops quoteHash, depositRequestHash, destinationHash)
//	RefundWitness   binding 11,        V1 hashes 8  (same three)
//	ReserveWitness  binding 4,         V1 hashes 2  (drops quoteHash, sourceAmount)
//
// Populating a dropped member and calling a V1 digest used to succeed and return a digest that
// committed to none of them — no compile error, no runtime signal, and a deposit the escrow can
// neither release nor refund because it cannot tell a dropped commitment from a wrong one.
//
// These tests pin the fail-closed behaviour on all four, plus the two arms that must NOT change:
// a zero-valued member is still "not supplied" (so pre-redeploy callers work unchanged), and the
// V2 siblings still accept the fully populated witness.
//
// The assertions deliberately check errors.Is(err, ErrV1WitnessDropsMembers) and the presence of
// the dropped member NAMES rather than whole message strings, so the diagnostic wording can be
// improved without a test edit.

func depositWitnessFixture() contracts.IEscrowDepositWitness {
	return contracts.IEscrowDepositWitness{
		Reserver: common.HexToAddress("0x1111111111111111111111111111111111111111"),
		Releaser: common.HexToAddress("0x2222222222222222222222222222222222222222"),
	}
}

// requireDroppedMemberError asserts a V1 digest call failed closed, naming the members.
func requireDroppedMemberError(t *testing.T, err error, wantMembers ...string) {
	t.Helper()
	if err == nil {
		t.Fatal("expected the V1 digest to FAIL CLOSED on a witness carrying members it does not " +
			"hash; returning a digest that commits to none of them is the silent-drop defect this " +
			"guard exists to remove")
	}
	if !errors.Is(err, ErrV1WitnessDropsMembers) {
		t.Fatalf("error must wrap ErrV1WitnessDropsMembers so callers can errors.Is it, got: %v", err)
	}
	for _, m := range wantMembers {
		if !strings.Contains(err.Error(), m) {
			t.Fatalf("error must name the dropped member %q so the caller knows which field to move "+
				"to the V2 builder, got: %v", m, err)
		}
	}
}

func TestDepositV1DigestRejectsDroppedCommitmentMembers(t *testing.T) {
	encoder := NewEscrowDepositEncoder()
	digest := func(w contracts.IEscrowDepositWitness) error {
		_, err := encoder.Digest(
			common.Address{}, common.Address{}, common.Address{}, w,
			big.NewInt(1), big.NewInt(2), big.NewInt(3), big.NewInt(1),
		)
		return err
	}
	digestWithTypedData := func(w contracts.IEscrowDepositWitness) error {
		_, _, err := encoder.DigestWithTypedData(
			common.Address{}, common.Address{}, common.Address{}, w,
			big.NewInt(1), big.NewInt(2), big.NewInt(3), big.NewInt(1),
		)
		return err
	}

	t.Run("depositRequestHash alone is rejected", func(t *testing.T) {
		w := depositWitnessFixture()
		w.DepositRequestHash = [32]byte{0xaa}
		requireDroppedMemberError(t, digest(w), "depositRequestHash")
		requireDroppedMemberError(t, digestWithTypedData(w), "depositRequestHash")
	})

	t.Run("destination alone is rejected", func(t *testing.T) {
		w := depositWitnessFixture()
		w.Destination = "eip155:8453/erc20:0xdead@0xbeef"
		requireDroppedMemberError(t, digest(w), "destination")
		requireDroppedMemberError(t, digestWithTypedData(w), "destination")
	})

	t.Run("both members are named in one error", func(t *testing.T) {
		w := depositWitnessFixture()
		w.DepositRequestHash = [32]byte{0xaa}
		w.Destination = "eip155:8453/erc20:0xdead@0xbeef"
		requireDroppedMemberError(t, digest(w), "depositRequestHash", "destination")
	})

	t.Run("the error points at the V2 builder", func(t *testing.T) {
		w := depositWitnessFixture()
		w.Destination = "eip155:8453/erc20:0xdead@0xbeef"
		err := digest(w)
		if err == nil || !strings.Contains(err.Error(), "DigestWithDestination") {
			t.Fatalf("the rejection must name the sibling that DOES hash the member, otherwise the "+
				"caller has no way forward from the error alone; got: %v", err)
		}
	})

	t.Run("a bare two-member witness still signs", func(t *testing.T) {
		if err := digest(depositWitnessFixture()); err != nil {
			t.Fatalf("zero-valued members mean NOT SUPPLIED; every pre-redeploy caller passes exactly "+
				"this witness and must keep working: %v", err)
		}
		if err := digestWithTypedData(depositWitnessFixture()); err != nil {
			t.Fatalf("DigestWithTypedData (bare witness): %v", err)
		}
	})

	t.Run("the V2 sibling accepts the fully populated witness", func(t *testing.T) {
		w := depositWitnessFixture()
		w.DepositRequestHash = [32]byte{0xaa}
		w.Destination = "eip155:8453/erc20:0xdead@0xbeef"
		if _, _, err := encoder.DigestWithDestination(
			common.Address{}, common.Address{}, common.Address{}, w,
			big.NewInt(1), big.NewInt(2), big.NewInt(3), big.NewInt(1),
		); err != nil {
			t.Fatalf("the guard must reject only the V1 path — V2 is where these members belong: %v", err)
		}
	})
}

func TestReleaseV1DigestRejectsDroppedSettlementMembers(t *testing.T) {
	encoder := NewEscrowReleaseEncoder()
	chainID := big.NewInt(1)
	digest := func(w contracts.IEscrowReleaseWitness) error {
		_, err := encoder.Digest(common.Address{}, w, chainID)
		return err
	}
	digestWithTypedData := func(w contracts.IEscrowReleaseWitness) error {
		_, _, err := encoder.DigestWithTypedData(common.Address{}, w, chainID)
		return err
	}

	for _, tc := range []struct {
		name   string
		mutate func(*contracts.IEscrowReleaseWitness)
		member string
	}{
		{"quoteHash", func(w *contracts.IEscrowReleaseWitness) { w.QuoteHash = [32]byte{0x01} }, "quoteHash"},
		{"depositRequestHash", func(w *contracts.IEscrowReleaseWitness) { w.DepositRequestHash = [32]byte{0x02} }, "depositRequestHash"},
		{"destinationHash", func(w *contracts.IEscrowReleaseWitness) { w.DestinationHash = [32]byte{0x03} }, "destinationHash"},
	} {
		tc := tc
		t.Run(tc.name+" is rejected", func(t *testing.T) {
			w := releaseWitnessFixture([32]byte{})
			tc.mutate(&w)
			requireDroppedMemberError(t, digest(w), tc.member)
			requireDroppedMemberError(t, digestWithTypedData(w), tc.member)
		})
	}

	t.Run("an eight-member witness still signs", func(t *testing.T) {
		if err := digest(releaseWitnessFixture([32]byte{})); err != nil {
			t.Fatalf("zero-valued members mean NOT SUPPLIED: %v", err)
		}
	})

	t.Run("the V2 sibling accepts all three", func(t *testing.T) {
		w := releaseWitnessFixture([32]byte{0x01})
		w.DepositRequestHash = [32]byte{0x02}
		w.DestinationHash = [32]byte{0x03}
		if _, _, err := encoder.DigestWithQuoteHash(common.Address{}, w, [32]byte{0x01}, chainID); err != nil {
			t.Fatalf("V2 release digest must accept the widened witness: %v", err)
		}
	})
}

func TestRefundV1DigestRejectsDroppedSettlementMembers(t *testing.T) {
	encoder := NewEscrowRefundEncoder()
	chainID := big.NewInt(1)
	digest := func(w contracts.IEscrowRefundWitness) error {
		_, err := encoder.Digest(common.Address{}, w, chainID)
		return err
	}
	digestWithTypedData := func(w contracts.IEscrowRefundWitness) error {
		_, _, err := encoder.DigestWithTypedData(common.Address{}, w, chainID)
		return err
	}

	for _, tc := range []struct {
		name   string
		mutate func(*contracts.IEscrowRefundWitness)
		member string
	}{
		{"quoteHash", func(w *contracts.IEscrowRefundWitness) { w.QuoteHash = [32]byte{0x01} }, "quoteHash"},
		{"depositRequestHash", func(w *contracts.IEscrowRefundWitness) { w.DepositRequestHash = [32]byte{0x02} }, "depositRequestHash"},
		{"destinationHash", func(w *contracts.IEscrowRefundWitness) { w.DestinationHash = [32]byte{0x03} }, "destinationHash"},
	} {
		tc := tc
		t.Run(tc.name+" is rejected", func(t *testing.T) {
			w := refundWitnessFixture([32]byte{})
			tc.mutate(&w)
			requireDroppedMemberError(t, digest(w), tc.member)
			requireDroppedMemberError(t, digestWithTypedData(w), tc.member)
		})
	}

	t.Run("an eight-member witness still signs", func(t *testing.T) {
		if err := digest(refundWitnessFixture([32]byte{})); err != nil {
			t.Fatalf("zero-valued members mean NOT SUPPLIED: %v", err)
		}
	})
}

func TestReserveV1DigestRejectsDroppedQuoteMembers(t *testing.T) {
	encoder := NewEscrowReserveEncoder()
	chainID := big.NewInt(1)
	settler := common.HexToAddress("0x2222222222222222222222222222222222222222")
	base := contracts.IEscrowReserveWitness{DepositId: [32]byte{0x09}, Settler: settler}

	t.Run("quoteHash is rejected", func(t *testing.T) {
		w := base
		w.QuoteHash = [32]byte{0x01}
		_, err := encoder.Digest(common.Address{}, w, chainID)
		requireDroppedMemberError(t, err, "quoteHash")
		_, _, err = encoder.DigestWithTypedData(common.Address{}, w, chainID)
		requireDroppedMemberError(t, err, "quoteHash")
	})

	t.Run("sourceAmount is rejected", func(t *testing.T) {
		w := base
		w.SourceAmount = big.NewInt(1_000_000)
		_, err := encoder.Digest(common.Address{}, w, chainID)
		requireDroppedMemberError(t, err, "sourceAmount")
	})

	t.Run("a nil or zero sourceAmount means not-supplied", func(t *testing.T) {
		if _, err := encoder.Digest(common.Address{}, base, chainID); err != nil {
			t.Fatalf("nil SourceAmount must not be treated as supplied — every V1 caller leaves it "+
				"nil, and a nil *big.Int cannot be distinguished from an intentional zero: %v", err)
		}
		zeroed := base
		zeroed.SourceAmount = big.NewInt(0)
		if _, err := encoder.Digest(common.Address{}, zeroed, chainID); err != nil {
			t.Fatalf("an explicit zero SourceAmount authorizes nothing, so it cannot be a lost "+
				"commitment: %v", err)
		}
	})

	t.Run("the V2 sibling accepts both", func(t *testing.T) {
		if _, err := encoder.DigestWithQuoteSource(
			common.Address{}, base.DepositId, [32]byte{0x01}, settler, big.NewInt(1_000_000), chainID,
		); err != nil {
			t.Fatalf("V2 reserve digest must accept the widened witness: %v", err)
		}
	})
}
