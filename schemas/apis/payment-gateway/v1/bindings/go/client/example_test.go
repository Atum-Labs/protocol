package pgclient_test

import (
	"encoding/json"
	"fmt"
	"time"

	pgclient "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client"
	"github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/senderauth"
	lddataintegrity "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/common/ld-data-integrity/go"
	"github.com/ethereum/go-ethereum/crypto"
)

// A PaymentRequest carries three unrelated signatures and an originator generally needs more
// than one. The examples below cover each in turn; this one names them, because choosing the
// wrong one is the mistake the API shape is designed to prevent.
//
//   - SignSenderAuth authorizes the on-chain TRANSFER.
//   - SignDeclaration attests that the DOCUMENT came from its signer.
//   - BuildEnvelope carries the originator's IDENTITY.
//
// Signing one does not stand in for another: a request with a valid sender_auth and no
// identity envelope authorizes a transfer by an unidentified originator, and the reverse
// identifies an originator who has authorized nothing.
func Example() {
	fmt.Println("sender_auth  -> SignSenderAuth        (moves funds)")
	fmt.Println("proof        -> SignDeclaration       (attests the document)")
	fmt.Println("presentation -> BuildEnvelope         (identifies the originator)")
	// Output:
	// sender_auth  -> SignSenderAuth        (moves funds)
	// proof        -> SignDeclaration       (attests the document)
	// presentation -> BuildEnvelope         (identifies the originator)
}

// Signing the transfer authorization. The signer holds the key; this package never sees it.
// senderauth.LocalKeySigner covers a raw local key, and a custodian implements the same
// one-method interface over its own signing call.
func ExampleSignSenderAuth() {
	req := &pgclient.PaymentRequest{
		SenderAuth: &pgclient.SenderAuth{
			MessageScheme: "EVM_PERMIT2",
			SignedMessages: []pgclient.SignedMessage{{
				Message: "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
			}},
		},
	}

	signer, err := senderauth.LocalKeySigner(
		"eip155:1",
		"ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
	)
	if err != nil {
		panic(err)
	}

	if err := pgclient.SignSenderAuth(req, signer); err != nil {
		panic(err)
	}

	fmt.Println("signature filled:", req.SenderAuth.SignedMessages[0].Signature != "")
	// Output:
	// signature filled: true
}

// Signing the document itself. The verificationMethod names the signing key as a DID URL;
// VerificationMethodForAccount builds it from the holder's chain and address.
func ExampleSignDeclaration() {
	priv, err := crypto.HexToECDSA("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	if err != nil {
		panic(err)
	}
	signer, err := lddataintegrity.NewECDSASigner(priv)
	if err != nil {
		panic(err)
	}

	const (
		chainID = "eip155:1"
		account = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
	)

	signed, err := pgclient.SignDeclarationJSON(
		[]byte(`{"version":"1.0","request_id":"req-1"}`),
		signer,
		pgclient.DeclarationOptions{
			VerificationMethod: pgclient.VerificationMethodForAccount(chainID, account),
			// Pinned so this example's output is stable; production leaves it as time.Now().
			Created: time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC),
		},
	)
	if err != nil {
		panic(err)
	}

	var doc struct {
		Proof struct {
			ProofPurpose       string `json:"proofPurpose"`
			VerificationMethod string `json:"verificationMethod"`
		} `json:"proof"`
	}
	if err := json.Unmarshal(signed, &doc); err != nil {
		panic(err)
	}

	fmt.Println("proofPurpose:      ", doc.Proof.ProofPurpose)
	fmt.Println("verificationMethod:", doc.Proof.VerificationMethod)
	// Output:
	// proofPurpose:       assertionMethod
	// verificationMethod: did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266#blockchainAccountId
}

// Building the identity envelope. The credential bag and the signing key are both supplied by
// the caller; the envelope requires at least one credential, so an originator that holds none
// cannot produce one yet.
func ExampleBuildEnvelope() {
	priv, err := crypto.HexToECDSA("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	if err != nil {
		panic(err)
	}
	signer, err := lddataintegrity.NewECDSASigner(priv)
	if err != nil {
		panic(err)
	}

	// No PaymentRequestDoc: BuildEnvelope does not read it. EnvelopeOptions is one struct
	// shared with the inner-signing entry point, so the fields each one reads are not obvious
	// from the type; passing a dummy document here would document the opposite.
	envelope, err := pgclient.BuildEnvelope(pgclient.EnvelopeOptions{
		HolderVCs: []json.RawMessage{json.RawMessage(`{
			"@context": ["https://www.w3.org/2018/credentials/v1"],
			"type": ["VerifiableCredential"],
			"issuer": "did:web:devnet.atum.network",
			"credentialSubject": {"id": "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"}
		}`)},
		Signer:        signer,
		ChainID:       "eip155:1",
		HolderAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
		// The challenge binds the envelope to one request and the domain to one environment;
		// the gateway checks both.
		Challenge: "req-1",
		Domain:    "did:web:devnet.atum.network",
		Now:       time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC),
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
	fmt.Println("challenge:   ", doc.Proof.Challenge)
	fmt.Println("domain:      ", doc.Proof.Domain)
	// Output:
	// proofPurpose: authentication
	// challenge:    req-1
	// domain:       did:web:devnet.atum.network
}
