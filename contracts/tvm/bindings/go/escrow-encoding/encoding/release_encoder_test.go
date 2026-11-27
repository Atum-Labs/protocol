package encoding

import (
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/generated"

	"github.com/ethereum/go-ethereum/common"
)

// TestReleaseEncoder_V3_FromExamples uses the "release" reference in
// the TVM escrow contract's encoding examples (Shasta-deployed escrow, V3
// witness shape: paymentId, depositor, token, amount, feeAmount, reserver,
// releaser, settler).
func TestReleaseEncoder_V3_FromExamples(t *testing.T) {
	const expectedDigestHex = "66d5cef8353064168adc4fc3ae1b902fddc16c6084275d11aff71d85f564e12c"

	encoder := NewEscrowReleaseEncoder()

	var paymentID [32]byte
	copy(paymentID[:], common.HexToHash("0xd927076fea2c62b09e3b0b7fe343573849be3933d4d645dbaa8fd0bbc06f13bc").Bytes())

	witness := contracts.IEscrowReleaseWitness{
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
