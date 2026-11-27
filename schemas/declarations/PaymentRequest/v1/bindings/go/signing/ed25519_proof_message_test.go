package ldverification

import (
	"crypto/ed25519"
	"encoding/json"
	"strings"
	"testing"
	"time"

	paymentrequest "github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/generated"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// The PaymentRequest Ed25519 proof signs the raw SigningInput by default and
// Ed25519ProofMessage(SigningInput) with TextProof; VerifyPaymentRequest accepts
// both and rejects a signature over another input.
func TestVerify_Ed25519_AcceptsRawAndText(t *testing.T) {
	signed := readFixture(t, "ed25519-go-signed.json")
	if _, err := VerifyPaymentRequest(signed); err != nil {
		t.Fatalf("Verify of the fixture: %v", err)
	}

	var req paymentrequest.SchemaJson
	if err := json.Unmarshal(signed, &req); err != nil {
		t.Fatal(err)
	}
	hash, err := canonicalSigningInput(signed, &req, ProofTypeEd25519Signature2020)
	if err != nil {
		t.Fatal(err)
	}
	text, err := lddataintegrity.Ed25519ProofMessage(hash.SigningInput)
	if err != nil {
		t.Fatal(err)
	}
	other := append([]byte(nil), hash.SigningInput...)
	other[0] ^= 0xff
	resign := func(msg []byte) []byte {
		var doc map[string]any
		if err := json.Unmarshal(signed, &doc); err != nil {
			t.Fatal(err)
		}
		var seed [32]byte
		pv, err := lddataintegrity.EncodeEd25519ProofValue(ed25519.Sign(ed25519.NewKeyFromSeed(seed[:]), msg))
		if err != nil {
			t.Fatal(err)
		}
		doc["proof"].(map[string]any)["proofValue"] = pv
		out, err := json.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	for name, msg := range map[string][]byte{"raw": hash.SigningInput, "text": text} {
		if _, err := VerifyPaymentRequest(resign(msg)); err != nil {
			t.Fatalf("Verify of the %s form: %v", name, err)
		}
	}
	_, err = VerifyPaymentRequest(resign(other))
	if err == nil || !strings.Contains(err.Error(), "signature verification failed") {
		t.Fatalf("Verify of a signature over another SigningInput: err = %v, want the ed25519 signature failure", err)
	}

	// Both signers sign the raw SigningInput by default and the text with TextProof.
	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	delete(doc, "proof")
	created, err := time.Parse(time.RFC3339Nano, proof["created"].(string))
	if err != nil {
		t.Fatal(err)
	}
	var seed [32]byte
	priv := ed25519.NewKeyFromSeed(seed[:])
	sign := map[string]func(SignEd25519Options) ([]byte, error){
		"SignPaymentRequestEd25519": func(o SignEd25519Options) ([]byte, error) {
			o.Created = created
			return SignPaymentRequestEd25519(doc, priv, o)
		},
		"SignPaymentRequestEd25519WithCreatedString": func(o SignEd25519Options) ([]byte, error) {
			return SignPaymentRequestEd25519WithCreatedString(doc, priv, o, proof["created"].(string))
		},
	}
	for name, fn := range sign {
		for _, tc := range []struct {
			textProof bool
			want      []byte
		}{{false, hash.SigningInput}, {true, text}} {
			out, err := fn(SignEd25519Options{
				VerificationMethod: proof["verificationMethod"].(string),
				ProofPurpose:       proof["proofPurpose"].(string),
				TextProof:          tc.textProof,
			})
			if err != nil {
				t.Fatal(err)
			}
			var got, want map[string]any
			if err := json.Unmarshal(out, &got); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(resign(tc.want), &want); err != nil {
				t.Fatal(err)
			}
			if got["proof"].(map[string]any)["proofValue"] != want["proof"].(map[string]any)["proofValue"] {
				t.Fatalf("%s TextProof=%v signed the wrong message", name, tc.textProof)
			}
		}
	}
}
