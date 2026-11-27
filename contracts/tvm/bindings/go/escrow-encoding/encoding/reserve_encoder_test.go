package encoding

import (
	"bytes"
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/generated"

	"github.com/ethereum/go-ethereum/common"
)

// TestReserveEncoder_V3_FromExamples uses the "reserve" reference in
// the TVM escrow contract's encoding examples (Shasta-deployed escrow, V3
// witness shape {paymentId, settler}).
func TestReserveEncoder_V3_FromExamples(t *testing.T) {
	const expectedDigestHex = "b0245d1de88ea677343ff99c9f83434c60a3f6438475d28731231d9be64bcca7"

	encoder := NewEscrowReserveEncoder()

	var paymentID [32]byte
	copy(paymentID[:], common.HexToHash("0xd927076fea2c62b09e3b0b7fe343573849be3933d4d645dbaa8fd0bbc06f13bc").Bytes())

	witness := contracts.IEscrowReserveWitness{
		DepositId: paymentID,
		Settler:   mustTVMAddress(t, "TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N"),
	}

	digest, err := encoder.Digest(
		mustTVMAddress(t, "TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py"),
		witness,
		big.NewInt(shastaChainID),
	)
	if err != nil {
		t.Fatalf("Digest() error: %v", err)
	}

	got := strings.ToLower(hex.EncodeToString(digest))
	if got != expectedDigestHex {
		t.Errorf("digest mismatch:\n  got:  %s\n  want: %s", got, expectedDigestHex)
	}
}

// The digest-only methods must agree with their TypedData counterparts. The V2 pair delegates, the
// V1 pair hashes independently through BuildTypedData, so this covers both shapes. Names and arity
// mirror the EVM reserve encoder on purpose, since bid_awarder.go imports both side by side.
func TestReserveDigestMatchesTypedData(t *testing.T) {
	enc := NewEscrowReserveEncoder()
	escrow := common.HexToAddress("0x1111111111111111111111111111111111111111")
	settler := common.HexToAddress("0x2222222222222222222222222222222222222222")
	chainID := big.NewInt(728126428)
	var paymentID, quoteHash [32]byte
	for i := range paymentID {
		paymentID[i] = byte(i)
		quoteHash[i] = byte(0xff - i)
	}

	t.Run("V1", func(t *testing.T) {
		witness := contracts.IEscrowReserveWitness{DepositId: paymentID, Settler: settler}
		// CORE-1863 renamed the Go field PaymentId -> DepositId. The V1 TIP-712 member is still
		// named "paymentId" (that is what the DEPLOYED contract pins), so BuildTypedData sources
		// it from DepositId - only the struct literal moves. #41 landed this test before that
		// rename, and the two merge textually clean while not compiling together.
		digest, err := enc.Digest(escrow, witness, chainID)
		if err != nil {
			t.Fatalf("Digest: %v", err)
		}
		fromTyped, _, err := enc.DigestWithTypedData(escrow, witness, chainID)
		if err != nil {
			t.Fatalf("DigestWithTypedData: %v", err)
		}
		if !bytes.Equal(digest, fromTyped) {
			t.Fatalf("V1 digests diverged: %x vs %x", digest, fromTyped)
		}
	})

	t.Run("V2 quote source", func(t *testing.T) {
		sourceAmount := big.NewInt(1_000_000)
		digest, err := enc.DigestWithQuoteSource(escrow, paymentID, quoteHash, settler, sourceAmount, chainID)
		if err != nil {
			t.Fatalf("DigestWithQuoteSource: %v", err)
		}
		fromTyped, _, err := enc.DigestWithQuoteSourceTypedData(escrow, paymentID, quoteHash, settler, sourceAmount, chainID)
		if err != nil {
			t.Fatalf("DigestWithQuoteSourceTypedData: %v", err)
		}
		if !bytes.Equal(digest, fromTyped) {
			t.Fatalf("V2 digests diverged: %x vs %x", digest, fromTyped)
		}
	})
}
