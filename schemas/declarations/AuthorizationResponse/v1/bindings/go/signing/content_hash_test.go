package authorizationresponse

import (
	"encoding/json"
	"errors"
	"regexp"
	"testing"
)

// responseHashPattern: "0x" + 64 lowercase hex (uniform 32-byte keccak256),
// identical width/format to the request-side request_hash.
var responseHashPattern = regexp.MustCompile(`^0x[0-9a-f]{64}$`)

// baseResponseJSON is a minimal signed-shaped AuthorizationResponse. The proof
// is present (and content-irrelevant) so the tests can assert proof-independence.
const baseResponseJSON = `{
  "@context": [
    "https://schemas.atum.network/declarations/AuthorizationResponse/v1/context.jsonld",
    "https://w3id.org/security/suites/secp256k1recovery-2020/v2"
  ],
  "payment_id": "0x1234abcd",
  "counterparty_did": "did:pkh:eip155:1:0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "status": "authorized",
  "proof": {
    "type": "EcdsaSecp256k1RecoverySignature2020",
    "created": "2026-05-20T00:01:00Z",
    "verificationMethod": "did:pkh:eip155:1:0x70997970c51812dc3a010c7d01b50e0d17dc79c8#blockchainAccountId",
    "proofPurpose": "assertionMethod",
    "jws": "eyJhbGciOiJFUzI1NkstUiIsImI2NCI6ZmFsc2UsImNyaXQiOlsiYjY0Il19..SIG"
  }
}`

func mustHash(t *testing.T, raw string) string {
	t.Helper()
	h, err := ComputeResponseHash([]byte(raw))
	if err != nil {
		t.Fatalf("ComputeResponseHash: %v", err)
	}
	return h
}

func TestComputeResponseHash_FormatAndDeterministic(t *testing.T) {
	h1 := mustHash(t, baseResponseJSON)
	if !responseHashPattern.MatchString(h1) {
		t.Errorf("response_hash %q does not match %s", h1, responseHashPattern)
	}
	h2 := mustHash(t, baseResponseJSON)
	if h1 != h2 {
		t.Errorf("non-deterministic: %s != %s", h1, h2)
	}
}

// IgnoresProof: the inner response's own proof must be inert — re-signing with a
// new proof.created / jws yields the SAME response_hash (pure content).
func TestComputeResponseHash_IgnoresProof(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal([]byte(baseResponseJSON), &doc); err != nil {
		t.Fatal(err)
	}
	// Mutate the proof wholesale (new created + jws).
	doc["proof"] = map[string]any{
		"type":               "EcdsaSecp256k1RecoverySignature2020",
		"created":            "2099-01-01T00:00:00Z",
		"verificationMethod": "did:pkh:eip155:1:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef#blockchainAccountId",
		"proofPurpose":       "assertionMethod",
		"jws":                "eyJhbGciOiJFUzI1NkstUiJ9..DIFFERENT",
	}
	mutated, _ := json.Marshal(doc)
	if mustHash(t, baseResponseJSON) != mustHash(t, string(mutated)) {
		t.Error("mutating proof changed response_hash — not proof-independent")
	}
}

// StripsVerifiableCredential: a (well-formed) VC bag spliced onto the inner
// response must be inert (credentials ride only in the envelope). The verifier
// recomputes over the stripped body and MUST match the producer's hash.
func TestComputeResponseHash_StripsVerifiableCredential(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal([]byte(baseResponseJSON), &doc); err != nil {
		t.Fatal(err)
	}
	doc["verifiableCredential"] = []any{
		map[string]any{
			"@context":          []any{"https://www.w3.org/2018/credentials/v1"},
			"id":                "urn:uuid:should-be-ignored",
			"type":              []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
			"issuer":            "did:web:atum.network",
			"issuanceDate":      "2026-05-20T00:00:00.000Z",
			"credentialSubject": map[string]any{"id": "did:pkh:eip155:1:0xabc", "role": "psp"},
			"proof":             map[string]any{"type": "Ed25519Signature2020"},
		},
	}
	enriched, _ := json.Marshal(doc)
	if mustHash(t, baseResponseJSON) != mustHash(t, string(enriched)) {
		t.Error("adding verifiableCredential changed response_hash — VC not stripped")
	}
}

// ChangesOnPaymentIDMutation: THE anti-replay invariant. response_hash is safe
// as the ARE challenge only because payment_id is part of the canonical content
// — distinct payments MUST get distinct hashes.
func TestComputeResponseHash_ChangesOnPaymentIDMutation(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal([]byte(baseResponseJSON), &doc); err != nil {
		t.Fatal(err)
	}
	doc["payment_id"] = "0xfeedface"
	mutated, _ := json.Marshal(doc)
	if mustHash(t, baseResponseJSON) == mustHash(t, string(mutated)) {
		t.Error("mutating payment_id did NOT change response_hash — anti-replay invariant broken")
	}
}

func TestComputeResponseHash_ChangesOnStatusMutation(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal([]byte(baseResponseJSON), &doc); err != nil {
		t.Fatal(err)
	}
	doc["status"] = "declined"
	doc["reason"] = "account suspended"
	mutated, _ := json.Marshal(doc)
	if mustHash(t, baseResponseJSON) == mustHash(t, string(mutated)) {
		t.Error("mutating status/reason did NOT change response_hash")
	}
}

// ContextInjection: a response declaring a non-canonical @context (extra
// entries / reordered) hashes identically to the canonical one — the wire
// @context is stripped and the canonical pair injected, so a context
// manipulation can't fork the hash. (A MISSING @context is rejected by the
// typed validation, which is correct fail-closed behavior — the wire response
// always carries one.)
func TestComputeResponseHash_ContextInjectionStable(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal([]byte(baseResponseJSON), &doc); err != nil {
		t.Fatal(err)
	}
	// Prepend an unrelated context + keep the canonical entries: still valid,
	// but not the canonical [AuthorizationResponseContextURL, suite] pair.
	doc["@context"] = []any{
		"https://www.w3.org/2018/credentials/v1",
		"https://schemas.atum.network/declarations/AuthorizationResponse/v1/context.jsonld",
		"https://w3id.org/security/suites/secp256k1recovery-2020/v2",
	}
	reordered, _ := json.Marshal(doc)
	if mustHash(t, baseResponseJSON) != mustHash(t, string(reordered)) {
		t.Error("response_hash depends on the wire @context — canonical injection regressed")
	}
}

func TestComputeResponseHash_Errors(t *testing.T) {
	if _, err := ComputeResponseHash([]byte("{not json")); !errors.Is(err, ErrMalformedResponse) {
		t.Errorf("expected ErrMalformedResponse, got %v", err)
	}
}
