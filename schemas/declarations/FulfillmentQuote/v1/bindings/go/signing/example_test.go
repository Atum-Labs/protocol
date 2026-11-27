package ldverification_test

import (
	"fmt"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	ldverification "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go/signing"
)

// A settler signs its FulfillmentQuote; anyone can verify it and recover the settler's address.
func ExampleSign() {
	priv, err := crypto.HexToECDSA("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	if err != nil {
		panic(err)
	}
	settler := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())

	quote := map[string]any{
		"version":              "1.0",
		"source_amount":        "1000000",
		"award_deadline":       "2030-01-01T00:00:00Z",
		"source":               map[string]any{"id": "eip155:1/erc20:0xaaa", "account": "eip155:1:0x1"},
		"destination":          map[string]any{"id": "eip155:8453/erc20:0xbbb", "account": "eip155:8453:0x2"},
		"settler_address":      settler,
		"payment_request_json": `{"request_id":"req-example-1"}`,
	}

	signed, err := ldverification.Sign(quote, priv, ldverification.SignOptions{
		VerificationMethod: "did:pkh:eip155:1:" + settler + "#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
		Created:            time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		panic(err)
	}

	res, err := ldverification.Verify(signed)
	if err != nil {
		panic(err)
	}
	recovered := res.Signer.(ldverification.RecoveredSecp256k1Signer).Address
	fmt.Println("quoted by:", strings.ToLower(recovered.Hex()))
	fmt.Println("is the settler:", strings.EqualFold(recovered.Hex(), settler))
	// Output:
	// quoted by: 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
	// is the settler: true
}
