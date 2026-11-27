package encoding

import (
	"bytes"
	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func TestReserveEncoder_Digest(t *testing.T) {
	examples := LoadEncodingExamples(t)
	encoder := NewEscrowReserveEncoder()

	for i, ex := range examples.Reserve {
		witness := contracts.IEscrowReserveWitness{
			DepositId: ex.PaymentId,
			Settler:   ex.Settler,
		}

		digest, err := encoder.Digest(ex.Escrow, witness, ex.ChainID)
		if err != nil {
			t.Errorf("Test %d: Failed to compute digest: %v", i, err)
			continue
		}

		if common.Bytes2Hex(digest) != common.Bytes2Hex(ex.ExpectedDigest) {
			t.Errorf("Test %d: Digest mismatch\nGot:      %s\nExpected: %s",
				i, common.Bytes2Hex(digest), common.Bytes2Hex(ex.ExpectedDigest))
		}
	}
}

// The digest-only methods delegate to their TypedData counterparts so there is one hashing site per
// witness version. If a caller ever reintroduces a second hashing path, these catch the divergence
// rather than leaving it to surface as a settler rejecting an award it should have accepted.
func TestReserveDigestDelegatesToTypedData(t *testing.T) {
	enc := NewEscrowReserveEncoder()
	escrow := common.HexToAddress("0x1111111111111111111111111111111111111111")
	settler := common.HexToAddress("0x2222222222222222222222222222222222222222")
	chainID := big.NewInt(42161)
	var paymentID, quoteHash [32]byte
	for i := range paymentID {
		paymentID[i] = byte(i)
		quoteHash[i] = byte(0xff - i)
	}

	t.Run("V1", func(t *testing.T) {
		witness := contracts.IEscrowReserveWitness{DepositId: paymentID, Settler: settler}
		// CORE-1863 renamed the Go field PaymentId -> DepositId. The V1 EIP-712 member is still
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
