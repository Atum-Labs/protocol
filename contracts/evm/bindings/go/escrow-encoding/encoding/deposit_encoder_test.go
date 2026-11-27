package encoding

import (
	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func TestDepositEncoder_Digest(t *testing.T) {
	examples := LoadEncodingExamples(t)
	encoder := NewEscrowDepositEncoder()

	for i, ex := range examples.Deposit {
		witness := contracts.IEscrowDepositWitness{
			Reserver: ex.Reserver,
			Releaser: ex.Releaser,
		}

		digest, err := encoder.Digest(
			ex.Permit2,
			ex.Token,
			ex.Spender,
			witness,
			ex.Amount,
			ex.Nonce,
			ex.Deadline,
			ex.ChainID,
		)
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
