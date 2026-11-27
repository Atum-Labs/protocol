package encoding

import (
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/generated"

	"github.com/ethereum/go-ethereum/common"
)

// TestRefundEncoder_V3_FromExamples uses the "refund" reference in
// the TVM escrow contract's encoding examples. RefundWitness has identical
// fields to ReleaseWitness; only the PrimaryType name differs.
func TestRefundEncoder_V3_FromExamples(t *testing.T) {
	const expectedDigestHex = "d5052181ecf31ec5cbf8f59ddeda833c56371cdfc04a53fe564dc67f757b420a"

	encoder := NewEscrowRefundEncoder()

	var paymentID [32]byte
	copy(paymentID[:], common.HexToHash("0xd927076fea2c62b09e3b0b7fe343573849be3933d4d645dbaa8fd0bbc06f13bc").Bytes())

	witness := contracts.IEscrowRefundWitness{
		DepositId: paymentID,
		Depositor: mustTVMAddress(t, "TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N"),
		Token:     mustTVMAddress(t, "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs"),
		Amount:    mustParseBigInt("100000000"),
		FeeAmount: big.NewInt(20000),
		Reserver:  mustTVMAddress(t, "TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N"),
		Releaser:  mustTVMAddress(t, "TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N"),
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
