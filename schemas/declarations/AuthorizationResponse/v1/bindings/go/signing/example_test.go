package authorizationresponse_test

import (
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	"github.com/atum-labs/protocol/schemas/declarations/AuthorizationResponse/v1/bindings/go/generated"
	authorizationresponse "github.com/atum-labs/protocol/schemas/declarations/AuthorizationResponse/v1/bindings/go/signing"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// localSigner implements ProofSigner over a raw secp256k1 key; a custodian implements the same interface.
type localSigner struct {
	priv *ecdsa.PrivateKey
	did  string
}

func (s localSigner) Sign(digest []byte) (string, error) {
	sig, err := crypto.Sign(digest, s.priv)
	if err != nil {
		return "", err
	}
	sig[64] += 27 // go-ethereum's recovery id is 0/1; the JWS expects 27/28
	return lddataintegrity.BuildSecp256k1JWS(sig)
}

func (s localSigner) VerificationMethod() string { return s.did + "#blockchainAccountId" }

func (s localSigner) SuiteType() string {
	return string(generated.DataIntegrityProofTypeEcdsaSecp256K1RecoverySignature2020)
}

// A counterparty signs its decision on a payment; the gateway verifies it against the counterparty's DID.
func ExampleBuildAuthorizationResponse() {
	priv, err := crypto.HexToECDSA("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	if err != nil {
		panic(err)
	}
	did := "did:pkh:eip155:1:" + strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

	resp, err := authorizationresponse.BuildAuthorizationResponse(
		generated.SchemaJsonStatusAuthorized, "pay-example-1", did, nil, localSigner{priv, did}, now)
	if err != nil {
		panic(err)
	}

	raw, err := json.Marshal(resp)
	if err != nil {
		panic(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		panic(err)
	}
	err = authorizationresponse.VerifyAuthorizationResponse(doc, did, authorizationresponse.VerifyOptions{Now: now})
	fmt.Println("status:", resp.Status)
	fmt.Println("verified:", err == nil)
	// Output:
	// status: authorized
	// verified: true
}
