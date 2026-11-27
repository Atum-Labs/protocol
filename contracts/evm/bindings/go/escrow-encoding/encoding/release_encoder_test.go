package encoding

import (
	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func TestReleaseEncoder_Digest(t *testing.T) {
	examples := LoadEncodingExamples(t)
	encoder := NewEscrowReleaseEncoder()

	for i, ex := range examples.Release {
		witness := contracts.IEscrowReleaseWitness{
			DepositId: ex.PaymentId,
			Depositor: ex.Depositor,
			Token:     ex.Token,
			Amount:    ex.Amount,
			FeeAmount: ex.FeeAmount,
			Reserver:  ex.Reserver,
			Releaser:  ex.Releaser,
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
