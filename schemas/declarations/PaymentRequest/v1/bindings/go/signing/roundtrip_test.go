package ldverification

import (
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
)

// signRequestForTest signs a schema-valid PaymentRequest with the given
// secp256k1 key via the production SignPaymentRequest path. Shared by the
// roundtrip + tamper tests.
func signRequestForTest(t *testing.T, priv *ecdsa.PrivateKey, created time.Time) []byte {
	t.Helper()
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	doc := map[string]any{
		"version":    "1.0",
		"request_id": "req-pr-1",
		"source": map[string]any{
			"asset_identifier": "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A",
			"account":          address,
		},
		"destination": []any{
			map[string]any{
				"asset_identifier": "eip155:1/erc20:0xbbb",
				"account":          "0x0000000000000000000000000000000000000002",
			},
		},
		"fulfillment_amount":      "1000000",
		"quote_deadline":          "2030-01-01T00:00:00Z",
		"fulfillment_deadline":    "2030-01-02T00:00:00Z",
		"escrow_contract_address": "0x0000000000000000000000000000000000000003",
		"fulfillment_verifier":    map[string]any{"account": "0x0000000000000000000000000000000000000004", "endpoint": "https://veri-fill.example.com"},
		"sender_auth": map[string]any{
			"message_scheme": "EVM_PERMIT2",
			"signed_messages": []any{
				map[string]any{"message": "0xdead", "message_prehash": "{}", "signature": "0xbeef"},
			},
		},
	}
	signed, err := SignPaymentRequest(doc, priv, SignOptions{
		VerificationMethod: "did:pkh:eip155:1:" + address + "#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
		Created:            created,
	})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

// TestRoundTrip exercises the full sign→verify path inside this Go module
// so a regression in canonicalization, JWS encoding, or address recovery
// fails here (not only in the cross-language conformance harness). Mirror
// of the FulfillmentQuote TestRoundTrip.
func TestRoundTrip(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	expected := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())

	signed := signRequestForTest(t, priv, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

	res, err := VerifyPaymentRequest(signed)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got := strings.ToLower(mustSecp256k1Signer(t, res).Hex()); got != expected {
		t.Errorf("recovered address = %s, want %s", got, expected)
	}
}

// TestVerify_Secp256k1_RejectsTamperedDocument is the load-bearing
// adversarial test: sign a request, mutate a top-level document field
// (fulfillment_amount) post-sign, and confirm the recovered address no
// longer matches the original signer.
//
// secp256k1 ECDSA recovery is non-failing — RecoverAddress always returns
// SOME address from any signature+hash pair. Tampering the document
// changes the canonical hash, which recovers a different address. The
// bare verifier returns no error; the security comes from the downstream
// caller comparing the recovered address against the verificationMethod
// DID + whitelist. This test pins that the recovered address actually
// differs after tampering.
func TestVerify_Secp256k1_RejectsTamperedDocument(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	expected := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	signed := signRequestForTest(t, priv, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

	if res, err := VerifyPaymentRequest(signed); err != nil {
		t.Fatalf("baseline verify of untampered request: %v", err)
	} else if got := strings.ToLower(mustSecp256k1Signer(t, res).Hex()); got != expected {
		t.Fatalf("baseline recovered = %s, want %s", got, expected)
	}

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["fulfillment_amount"] != "1000000" {
		t.Fatalf("fixture changed: fulfillment_amount = %v, want 1000000", doc["fulfillment_amount"])
	}
	doc["fulfillment_amount"] = "100000000"
	mutated, _ := json.Marshal(doc)

	res, err := VerifyPaymentRequest(mutated)
	if err == nil {
		got := strings.ToLower(mustSecp256k1Signer(t, res).Hex())
		if got == expected {
			t.Fatalf("tampered fulfillment_amount recovered the original signer (%s); verifier failed to re-canonicalize from raw bytes", got)
		}
	}
}

// TestVerify_PresentationAndVCSplice_Inert is the pinning test
// for the canonicalization strip set. The producer splices the holder's
// PaymentRequestEnvelope into the PaymentRequest `presentation` field AFTER
// the inner proof is computed; a stale `verifiableCredential` array could
// likewise be present. Both terms are bound in the PaymentRequest context,
// so if the verify path did not strip them they would canonicalize into the
// signing input and recovery would return a DIFFERENT address — the mirror
// image of TestVerify_Secp256k1_RejectsTamperedDocument. This test pins that
// splicing either field post-sign leaves the recovered signer UNCHANGED, so
// inner recovery no longer depends on json-gold's treatment of the bound
// terms.
func TestVerify_PresentationAndVCSplice_Inert(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	expected := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	signed := signRequestForTest(t, priv, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	// A schema-valid VC reused inside the envelope and at top level.
	validVC := map[string]any{
		"@context":          []any{"https://www.w3.org/2018/credentials/v1"},
		"id":                "urn:uuid:9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
		"type":              []any{"VerifiableCredential"},
		"issuer":            "did:web:spliced.example",
		"issuanceDate":      "2026-01-01T00:00:00Z",
		"credentialSubject": map[string]any{"id": "did:pkh:eip155:1:" + expected},
		"proof": map[string]any{
			"type": "EcdsaSecp256k1RecoverySignature2020", "created": "2026-01-01T00:00:00Z",
			"verificationMethod": "did:web:spliced.example#key-1", "proofPurpose": "assertionMethod", "jws": "ey..vc",
		},
	}
	// Splice the two bound terms in AFTER signing, exactly as the
	// producer splices the PaymentRequestEnvelope into presentation.
	doc["presentation"] = map[string]any{
		"@context":             []any{"https://www.w3.org/2018/credentials/v1"},
		"type":                 []any{"VerifiablePresentation", "PaymentRequestEnvelope"},
		"holder":               "did:pkh:eip155:1:" + expected,
		"verifiableCredential": []any{validVC},
		"proof": map[string]any{
			"type":               "EcdsaSecp256k1RecoverySignature2020",
			"created":            "2026-04-01T00:00:00Z",
			"verificationMethod": "did:pkh:eip155:1:" + expected + "#blockchainAccountId",
			"proofPurpose":       "authentication",
			"challenge":          "req-pr-1",
			"domain":             "did:web:devnet.atum.network",
			"jws":                "ey..spliced",
		},
	}
	doc["verifiableCredential"] = []any{validVC}
	spliced, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}

	res, err := VerifyPaymentRequest(spliced)
	if err != nil {
		t.Fatalf("verify after presentation/VC splice: %v", err)
	}
	if got := strings.ToLower(mustSecp256k1Signer(t, res).Hex()); got != expected {
		t.Fatalf("spliced presentation/verifiableCredential changed the recovered signer: got %s, want %s — the verify-side strip set regressed", got, expected)
	}
}

// TestCanonicalize_EmitsRequestIDQuad pins that the `request_id`
// declaration field actually appears in the URDNA2015 N-Quads output.
// URDNA2015 silently drops fields not bound in the active @context, so a
// regression where someone removed the `request_id` term from
// schemas/declarations/PaymentRequest/v1/context.jsonld would let an
// attacker mutate `request_id` on the wire without invalidating the
// signature.
func TestCanonicalize_EmitsRequestIDQuad(t *testing.T) {
	doc := map[string]any{
		"@context":   []any{paymentRequestContextURL},
		"version":    "1.0",
		"request_id": "req-pr-1",
		"source": map[string]any{
			"asset_identifier": "eip155:1/erc20:0xaaa",
			"account":          "0x1",
		},
		"destination": []any{
			map[string]any{"asset_identifier": "eip155:1/erc20:0xbbb", "account": "0x2"},
		},
		"fulfillment_amount":   "1000000",
		"quote_deadline":       "2030-01-01T00:00:00Z",
		"fulfillment_deadline": "2030-01-02T00:00:00Z",
	}

	quads, err := Canonicalize(doc)
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	const requestIDIRI = "<https://schemas.atum.network/requestId>"
	if !strings.Contains(quads, requestIDIRI) {
		t.Fatalf("canonicalized output missing %s — context.jsonld is not binding the `request_id` term, signed bytes will silently exclude it. quads:\n%s", requestIDIRI, quads)
	}
}

// TestVerify_Secp256k1_RejectsTamperedProofCreated confirms that mutating
// proof.created after signing changes the recovered address on the JWS
// path — pins documentForCanonicalization's rawString policy as a
// security invariant.
func TestVerify_Secp256k1_RejectsTamperedProofCreated(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	expected := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	signed := signRequestForTest(t, priv, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	proof["created"] = "2027-01-01T00:00:00.000Z"
	mutated, _ := json.Marshal(doc)

	res, err := VerifyPaymentRequest(mutated)
	if err == nil {
		got := strings.ToLower(mustSecp256k1Signer(t, res).Hex())
		if got == expected {
			t.Fatalf("tampered proof.created recovered the original signer (%s); rawString-from-proof policy regressed", got)
		}
	}
}

// TestVerify_Secp256k1_RejectsBitFlippedSignature flips one byte of the
// 65-byte signature inside the detached JWS and asserts the verifier
// either rejects the recovery outright or recovers a different address.
func TestVerify_Secp256k1_RejectsBitFlippedSignature(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	expected := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	signed := signRequestForTest(t, priv, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	jws := proof["jws"].(string)
	parts := strings.Split(jws, "..")
	if len(parts) != 2 {
		t.Fatalf("malformed JWS in fixture: %q", jws)
	}
	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode sig: %v", err)
	}
	if len(sigBytes) != 65 {
		t.Fatalf("expected 65-byte secp256k1 signature, got %d", len(sigBytes))
	}
	sigBytes[10] ^= 0xff // flip a byte mid-signature (avoid v at index 64)
	proof["jws"] = parts[0] + ".." + base64.RawURLEncoding.EncodeToString(sigBytes)
	mutated, _ := json.Marshal(doc)

	res, err := VerifyPaymentRequest(mutated)
	if err == nil {
		got := strings.ToLower(mustSecp256k1Signer(t, res).Hex())
		if got == expected {
			t.Fatalf("bit-flipped signature recovered the original signer (%s); regression in JWS / recovery path", got)
		}
	}
}

// TestVerify_RejectsUnsupportedCryptosuite confirms a proof.type the
// verifier doesn't implement is rejected with ErrUnsupportedProofType
// rather than silently bypassing verification.
func TestVerify_RejectsUnsupportedCryptosuite(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	signed := signRequestForTest(t, priv, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	proof["type"] = "BbsBlsSignature2020"
	mutated, _ := json.Marshal(doc)

	if _, err := VerifyPaymentRequest(mutated); err == nil {
		t.Fatal("expected verify to fail for unsupported proof.type")
	}
}

// TestVerify_RejectsWrongProofPurpose confirms proofPurpose other than
// assertionMethod is rejected up-front (W3C DI 1.0 §4.2 by-purpose gate).
func TestVerify_RejectsWrongProofPurpose(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	signed := signRequestForTest(t, priv, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	proof["proofPurpose"] = "authentication"
	mutated, _ := json.Marshal(doc)

	if _, err := VerifyPaymentRequest(mutated); err == nil {
		t.Fatal("expected verify to fail for non-assertionMethod proofPurpose")
	}
}
