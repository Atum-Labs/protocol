package ldverification

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"testing"
	"time"

	"github.com/mr-tron/base58"
)

// signRequestEd25519ForTest signs a schema-valid PaymentRequest with the
// given ed25519 key. The verificationMethod embeds pubBase58 — passing a
// DIFFERENT base58 than the signing key's pubkey is how the
// wrong-pubkey negative test forces a verification failure.
func signRequestEd25519ForTest(t *testing.T, priv ed25519.PrivateKey, pubBase58 string, created time.Time) []byte {
	t.Helper()
	doc := map[string]any{
		"version":    "1.0",
		"request_id": "req-pr-sol-1",
		"source": map[string]any{
			"asset_identifier": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/spltoken:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
			"account":          pubBase58,
		},
		"destination": []any{
			map[string]any{"asset_identifier": "eip155:1/erc20:0xbbb", "account": "0x2"},
		},
		"fulfillment_amount":      "1000000",
		"quote_deadline":          "2030-01-01T00:00:00Z",
		"fulfillment_deadline":    "2030-01-02T00:00:00Z",
		"escrow_contract_address": "0x0000000000000000000000000000000000000003",
		"fulfillment_verifier":    map[string]any{"account": "0x0000000000000000000000000000000000000004", "endpoint": "https://veri-fill.example.com"},
		"sender_auth": map[string]any{
			"message_scheme": "SOLANA",
			"signed_messages": []any{
				map[string]any{"message": "0xdead", "message_prehash": "{}", "signature": "0xbeef"},
			},
		},
	}
	signed, err := SignPaymentRequestEd25519(doc, priv, SignEd25519Options{
		VerificationMethod: "did:pkh:solana:devnet:" + pubBase58 + "#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
		Created:            created,
	})
	if err != nil {
		t.Fatalf("sign_ed25519: %v", err)
	}
	return signed
}

// TestRoundTrip_Ed25519 exercises the full sign→verify path for the
// Ed25519Signature2020 cryptosuite inline. Mirror of the FQ
// TestRoundTrip_Ed25519.
func TestRoundTrip_Ed25519(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)

	signed := signRequestEd25519ForTest(t, priv, pubBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	res, err := VerifyPaymentRequest(signed)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	signer := mustEd25519Signer(t, res)
	if !signer.PublicKey.Equal(pub) {
		t.Errorf("Ed25519PublicKey mismatch")
	}
	if signer.DIDNetwork != "devnet" {
		t.Errorf("DIDNetwork = %q, want %q", signer.DIDNetwork, "devnet")
	}
	if signer.DIDNamespace != "solana" {
		t.Errorf("DIDNamespace = %q, want %q", signer.DIDNamespace, "solana")
	}
}

// TestVerify_Ed25519_RejectsBadProofValue confirms that mutating the
// multibase-encoded signature flips the result to a verification error
// rather than returning a stale success.
func TestVerify_Ed25519_RejectsBadProofValue(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)
	signed := signRequestEd25519ForTest(t, priv, pubBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	pv := proof["proofValue"].(string)
	if len(pv) < 5 {
		t.Fatal("proofValue too short to mutate")
	}
	proof["proofValue"] = pv[:len(pv)-3] + "111"
	mutated, _ := json.Marshal(doc)

	if _, err := VerifyPaymentRequest(mutated); err == nil {
		t.Fatal("expected verify to fail for tampered proofValue")
	}
}

// TestVerify_Ed25519_RejectsWrongPubkey confirms the verifier honours the
// verificationMethod address — substituting an unrelated key in the DID
// makes verification fail closed.
func TestVerify_Ed25519_RejectsWrongPubkey(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	otherPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	otherBase58 := base58.Encode(otherPub)
	signed := signRequestEd25519ForTest(t, priv, otherBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	if _, err := VerifyPaymentRequest(signed); err == nil {
		t.Fatal("expected verify to fail when verificationMethod points at a different key")
	}
}

// TestVerify_Ed25519_RejectsNonZMultibasePrefix pins the strict 'z'
// (base58btc) prefix on proof.proofValue. The Ed25519Signature2020 spec
// mandates 'z'; loosening the check would silently widen the trust
// surface.
func TestVerify_Ed25519_RejectsNonZMultibasePrefix(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)
	signed := signRequestEd25519ForTest(t, priv, pubBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	pv := proof["proofValue"].(string)
	if pv[0] != 'z' {
		t.Fatalf("expected fixture proofValue to start with 'z', got %q", pv[:1])
	}
	proof["proofValue"] = "m" + pv[1:]
	mutated, _ := json.Marshal(doc)

	if _, err := VerifyPaymentRequest(mutated); err == nil {
		t.Fatal("expected verify to fail for non-z multibase prefix")
	}
}
