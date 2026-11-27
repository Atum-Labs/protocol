package encoding

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func TestPaymentIdEncoder_Digest(t *testing.T) {
	examples := LoadEncodingExamples(t)
	encoder := NewEscrowPaymentIdEncoder()

	for i, ex := range examples.PaymentId {
		digest, err := encoder.Digest(ex.Depositor, ex.Signature, ex.Nonce)
		if err != nil {
			t.Errorf("Test %d: Failed to compute digest: %v", i, err)
			continue
		}

		if common.Bytes2Hex(digest) != common.Bytes2Hex(ex.ExpectedPaymentId) {
			t.Errorf("Test %d: Digest mismatch\nGot:      %s\nExpected: %s",
				i, common.Bytes2Hex(digest), common.Bytes2Hex(ex.ExpectedPaymentId))
		}
	}
}
