package signing_test

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	signing "github.com/atum-labs/protocol/schemas/declarations/PaymentRequestEnvelope/v1/bindings/go/signing"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// The envelope presents the originator's credentials, bound to one request (challenge) and one environment (domain).
func ExampleBuildEnvelope() {
	priv, err := crypto.HexToECDSA("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	if err != nil {
		panic(err)
	}
	signer, err := lddataintegrity.NewECDSASigner(priv)
	if err != nil {
		panic(err)
	}

	envelope, err := signing.BuildEnvelope(signing.Options{
		HolderVCs: []json.RawMessage{json.RawMessage(`{
			"@context": ["https://www.w3.org/2018/credentials/v1"],
			"type": ["VerifiableCredential"],
			"issuer": "did:web:issuer.example.com",
			"credentialSubject": {"id": "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"}
		}`)},
		Signer:        signer,
		ChainID:       "eip155:1",
		HolderAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
		Challenge:     "req-example-1",
		Domain:        "did:web:example.com",
		Now:           time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		panic(err)
	}

	var doc struct {
		Proof struct {
			ProofPurpose string `json:"proofPurpose"`
			Challenge    string `json:"challenge"`
			Domain       string `json:"domain"`
		} `json:"proof"`
	}
	if err := json.Unmarshal(envelope, &doc); err != nil {
		panic(err)
	}
	fmt.Println("proofPurpose:", doc.Proof.ProofPurpose)
	fmt.Println("challenge:", doc.Proof.Challenge)
	fmt.Println("domain:", doc.Proof.Domain)
	// Output:
	// proofPurpose: authentication
	// challenge: req-example-1
	// domain: did:web:example.com
}
