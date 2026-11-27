package encoding

import (
	"math/big"
	"strings"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"github.com/ethereum/go-ethereum/common"
)

// The V2 release/refund builders keep a loose `quoteHash` parameter for API compatibility while the
// regenerated binding ALSO carries witness.QuoteHash. Two sources of truth for one signed member is
// a footgun: wire them from different places and the digest binds a quote the caller did not intend.
//
// DigestWithQuoteHash therefore fails closed on a populated-and-disagreeing witness.QuoteHash, and
// treats a zero witness.QuoteHash as "not supplied" so existing callers keep working unchanged.
// These tests pin all three arms of that contract.

func releaseWitnessFixture(quoteHash [32]byte) contracts.IEscrowReleaseWitness {
	return contracts.IEscrowReleaseWitness{
		QuoteHash: quoteHash,
		Amount:    big.NewInt(7),
		FeeAmount: big.NewInt(1),
	}
}

func refundWitnessFixture(quoteHash [32]byte) contracts.IEscrowRefundWitness {
	return contracts.IEscrowRefundWitness{
		QuoteHash: quoteHash,
		Amount:    big.NewInt(7),
		FeeAmount: big.NewInt(1),
	}
}

func TestReleaseDigestWithQuoteHashRejectsConflictingWitnessQuoteHash(t *testing.T) {
	arg := [32]byte{0xaa}
	other := [32]byte{0xbb}
	encoder := NewEscrowReleaseEncoder()
	chainID := big.NewInt(1)

	t.Run("conflicting witness QuoteHash is rejected", func(t *testing.T) {
		_, _, err := encoder.DigestWithQuoteHash(common.Address{}, releaseWitnessFixture(other), arg, chainID)
		if err == nil {
			t.Fatal("expected an error when witness.QuoteHash disagrees with the quoteHash argument; " +
				"silently preferring one of them is how a signature ends up binding the wrong quote")
		}
		if !strings.Contains(err.Error(), "disagrees") {
			t.Fatalf("error should name the conflict, got: %v", err)
		}
	})

	t.Run("zero witness QuoteHash means not-supplied", func(t *testing.T) {
		if _, _, err := encoder.DigestWithQuoteHash(
			common.Address{}, releaseWitnessFixture([32]byte{}), arg, chainID,
		); err != nil {
			t.Fatalf("a zero witness.QuoteHash must not be treated as a conflict: %v", err)
		}
	})

	t.Run("agreeing values are accepted and bind the same digest", func(t *testing.T) {
		withWitness, _, err := encoder.DigestWithQuoteHash(
			common.Address{}, releaseWitnessFixture(arg), arg, chainID)
		if err != nil {
			t.Fatalf("agreeing values must be accepted: %v", err)
		}
		withoutWitness, _, err := encoder.DigestWithQuoteHash(
			common.Address{}, releaseWitnessFixture([32]byte{}), arg, chainID)
		if err != nil {
			t.Fatalf("zero witness.QuoteHash: %v", err)
		}
		if common.Bytes2Hex(withWitness) != common.Bytes2Hex(withoutWitness) {
			t.Fatalf("the quoteHash argument must be what binds, so these digests must match:\n %s\n %s",
				common.Bytes2Hex(withWitness), common.Bytes2Hex(withoutWitness))
		}
	})
}

func TestRefundDigestWithQuoteHashRejectsConflictingWitnessQuoteHash(t *testing.T) {
	arg := [32]byte{0xaa}
	other := [32]byte{0xbb}
	encoder := NewEscrowRefundEncoder()
	chainID := big.NewInt(1)

	t.Run("conflicting witness QuoteHash is rejected", func(t *testing.T) {
		_, _, err := encoder.DigestWithQuoteHash(common.Address{}, refundWitnessFixture(other), arg, chainID)
		if err == nil {
			t.Fatal("expected an error when witness.QuoteHash disagrees with the quoteHash argument")
		}
		if !strings.Contains(err.Error(), "disagrees") {
			t.Fatalf("error should name the conflict, got: %v", err)
		}
	})

	t.Run("zero witness QuoteHash means not-supplied", func(t *testing.T) {
		if _, _, err := encoder.DigestWithQuoteHash(
			common.Address{}, refundWitnessFixture([32]byte{}), arg, chainID,
		); err != nil {
			t.Fatalf("a zero witness.QuoteHash must not be treated as a conflict: %v", err)
		}
	})
}

// TestV2DigestsCommitToDestinationCommitmentMembers proves the two members CORE-1863 restored are
// actually hashed, not merely declared in the Types map. A Types map can list a member while the
// Message omits it — apitypes would then hash a zero, the typehash guard would still pass, and the
// destination commitment would be decorative.
func TestV2DigestsCommitToDestinationCommitmentMembers(t *testing.T) {
	chainID := big.NewInt(1)
	quoteHash := [32]byte{0x01}

	releaseDigest := func(w contracts.IEscrowReleaseWitness) string {
		t.Helper()
		h, _, err := NewEscrowReleaseEncoder().DigestWithQuoteHash(common.Address{}, w, quoteHash, chainID)
		if err != nil {
			t.Fatalf("release digest: %v", err)
		}
		return common.Bytes2Hex(h)
	}
	refundDigest := func(w contracts.IEscrowRefundWitness) string {
		t.Helper()
		h, _, err := NewEscrowRefundEncoder().DigestWithQuoteHash(common.Address{}, w, quoteHash, chainID)
		if err != nil {
			t.Fatalf("refund digest: %v", err)
		}
		return common.Bytes2Hex(h)
	}

	baseRelease := releaseWitnessFixture([32]byte{})
	withRequestHash := baseRelease
	withRequestHash.DepositRequestHash = [32]byte{0x02}
	withDestinationHash := baseRelease
	withDestinationHash.DestinationHash = [32]byte{0x03}

	if releaseDigest(baseRelease) == releaseDigest(withRequestHash) {
		t.Fatal("release digest is INSENSITIVE to witness.DepositRequestHash — the member is declared " +
			"in the Types map but never reaches Message")
	}
	if releaseDigest(baseRelease) == releaseDigest(withDestinationHash) {
		t.Fatal("release digest is INSENSITIVE to witness.DestinationHash — the member is declared " +
			"in the Types map but never reaches Message")
	}

	baseRefund := refundWitnessFixture([32]byte{})
	refundWithRequestHash := baseRefund
	refundWithRequestHash.DepositRequestHash = [32]byte{0x02}
	refundWithDestinationHash := baseRefund
	refundWithDestinationHash.DestinationHash = [32]byte{0x03}

	if refundDigest(baseRefund) == refundDigest(refundWithRequestHash) {
		t.Fatal("refund digest is INSENSITIVE to witness.DepositRequestHash")
	}
	if refundDigest(baseRefund) == refundDigest(refundWithDestinationHash) {
		t.Fatal("refund digest is INSENSITIVE to witness.DestinationHash")
	}
}
