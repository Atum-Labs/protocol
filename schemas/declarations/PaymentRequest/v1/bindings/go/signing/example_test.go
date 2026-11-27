package ldverification_test

import (
	"fmt"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	ldverification "github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/signing"
)

// Sign a PaymentRequest, then verify it and check the recovered signer is the one the proof claims.
func ExampleSignPaymentRequest() {
	priv, err := crypto.HexToECDSA("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	if err != nil {
		panic(err)
	}
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())

	doc := map[string]any{
		"version":    "1.0",
		"request_id": "req-example-1",
		"source": map[string]any{
			"asset_identifier": "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A",
			"account":          address,
		},
		"destination": []any{map[string]any{
			"asset_identifier": "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			"account":          "0x0000000000000000000000000000000000000002",
		}},
		"fulfillment_amount":      "1000000",
		"quote_deadline":          "2030-01-01T00:00:00Z",
		"fulfillment_deadline":    "2030-01-02T00:00:00Z",
		"escrow_contract_address": "0x0000000000000000000000000000000000000003",
		"fulfillment_verifier":    map[string]any{"account": "0x0000000000000000000000000000000000000004", "endpoint": "https://veri-fill.example.com"},
		"sender_auth": map[string]any{
			"message_scheme":  "EVM_PERMIT2",
			"signed_messages": []any{map[string]any{"message": "0xdead", "message_prehash": "{}", "signature": "0xbeef"}},
		},
	}

	signed, err := ldverification.SignPaymentRequest(doc, priv, ldverification.SignOptions{
		VerificationMethod: "did:pkh:eip155:1:" + address + "#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
		Created:            time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		panic(err)
	}

	res, err := ldverification.VerifyPaymentRequest(signed)
	if err != nil {
		panic(err)
	}
	// Recovery always yields some address; binding it to the claimed signer is the caller's job.
	recovered := res.Signer.(ldverification.RecoveredSecp256k1Signer).Address
	fmt.Println("signed by:", strings.ToLower(recovered.Hex()))
	fmt.Println("matches claim:", strings.EqualFold(recovered.Hex(), address))
	// Output:
	// signed by: 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
	// matches claim: true
}
