package encoding

import (
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// TestPaymentIdEncoder_V3_FromExamples uses the "paymentId" reference in
// the TVM escrow contract's encoding examples — V3 paymentId =
// keccak256(abi.encode(depositor, signature, nonce)).
func TestPaymentIdEncoder_V3_FromExamples(t *testing.T) {
	const expectedPaymentIdHex = "d927076fea2c62b09e3b0b7fe343573849be3933d4d645dbaa8fd0bbc06f13bc"

	encoder := NewEscrowPaymentIdEncoder()

	signature := common.FromHex("0x164f0f9c1cd6a10420502792d408b54e81c73652f51db08b0da0884b3179c52877fd386c009a1b6fc242a5afcf03ab583c1a407bacbf1626c0ca30c7851d81ce1c")

	paymentID, err := encoder.Digest(
		"TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N",
		signature,
		big.NewInt(1776340107514),
	)
	if err != nil {
		t.Fatalf("Digest() error: %v", err)
	}

	got := strings.ToLower(hex.EncodeToString(paymentID))
	if got != expectedPaymentIdHex {
		t.Errorf("paymentId mismatch:\n  got:  %s\n  want: %s", got, expectedPaymentIdHex)
	}
}

// TestPaymentIdEncoder_DepositIdAlias verifies the V1-named alias still works.
func TestPaymentIdEncoder_DepositIdAlias(t *testing.T) {
	enc := NewEscrowDepositIdEncoder()
	signature := common.FromHex("0x164f0f9c1cd6a10420502792d408b54e81c73652f51db08b0da0884b3179c52877fd386c009a1b6fc242a5afcf03ab583c1a407bacbf1626c0ca30c7851d81ce1c")

	if _, err := enc.Digest("TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N", signature, big.NewInt(1)); err != nil {
		t.Errorf("alias Digest failed: %v", err)
	}
}
