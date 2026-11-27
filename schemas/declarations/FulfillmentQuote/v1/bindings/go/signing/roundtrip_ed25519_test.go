package ldverification

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/mr-tron/base58"
)

// TestRoundTrip_Ed25519 exercises the full sign→verify path for the
// Ed25519Signature2020 cryptosuite inline so a regression in
// canonicalization, multibase encoding, or DID parsing fires here
// instead of (or in addition to) the cross-language harness in
// production settlement agents. The signing logic mirrors the
// TypeScript ed25519 signer byte-for-byte.
func TestRoundTrip_Ed25519(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)

	signed := signEd25519ForTest(t, priv, pubBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	res, err := Verify(signed)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	signer := mustEd25519Signer(t, res)
	if !signer.PublicKey.Equal(pub) {
		t.Errorf("Ed25519PublicKey mismatch")
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
	signed := signEd25519ForTest(t, priv, pubBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	// Flip the last few characters of proof.proofValue.
	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	pv := proof["proofValue"].(string)
	if len(pv) < 5 {
		t.Fatal("proofValue too short to mutate")
	}
	proof["proofValue"] = pv[:len(pv)-3] + "111" // bs58btc 'a'/'b' replacement
	mutated, _ := json.Marshal(doc)

	if _, err := Verify(mutated); err == nil {
		t.Fatal("expected verify to fail for tampered proofValue")
	}
}

// TestVerify_Ed25519_RejectsWrongPubkey confirms the verifier honours
// the verificationMethod address — substituting an unrelated key in the
// DID makes verification fail closed.
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
	signed := signEd25519ForTest(t, priv, otherBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	if _, err := Verify(signed); err == nil {
		t.Fatal("expected verify to fail when verificationMethod points at a different key")
	}
}

// TestVerify_Ed25519_RejectsNonZMultibasePrefix pins the strict 'z'
// (base58btc) prefix on proof.proofValue. The Ed25519Signature2020
// spec mandates 'z'; loosening the check (e.g. accepting 'm' base64
// or treating any prefix as base58) would silently widen the trust
// surface — a regression this test catches.
func TestVerify_Ed25519_RejectsNonZMultibasePrefix(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)
	signed := signEd25519ForTest(t, priv, pubBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	// Replace the leading 'z' with 'm' (multibase indicator for base64).
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

	_, err = Verify(mutated)
	if err == nil {
		t.Fatal("expected verify to fail for non-'z' multibase prefix")
	}
	if !strings.Contains(err.Error(), "z-base58btc multibase") {
		t.Errorf("err = %v, want it to mention 'z-base58btc multibase'", err)
	}
}

// TestVerify_Ed25519_AcceptsCaseInsensitiveDIDScheme confirms the DID
// scheme/method portion is matched case-insensitively per W3C, while
// the base58 address payload is preserved verbatim (Solana base58 is
// case-sensitive — case-folding it would change which wallet we
// authorize).
func TestVerify_Ed25519_AcceptsCaseInsensitiveDIDScheme(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)

	// Sign with an upper-case DID scheme. The verifier must accept it,
	// and the recovered pubkey must equal the original.
	signed := signEd25519WithMethodForTest(
		t, priv, pubBase58,
		"DID:PKH:SOLANA:devnet:"+pubBase58+"#blockchainAccountId",
		time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC),
	)

	res, err := Verify(signed)
	if err != nil {
		t.Fatalf("verify with upper-case DID scheme: %v", err)
	}
	if !mustEd25519Signer(t, res).PublicKey.Equal(pub) {
		t.Errorf("Ed25519PublicKey mismatch")
	}
}

// TestVerify_Ed25519_RejectsEmptyProofValue covers the early-return
// guard in verifyEd25519. Without this test the explicit guard is
// dead-coded — a regression that dropped it would let the empty
// string fall through to lddataintegrity.DecodeEd25519ProofValue,
// which has its OWN empty-prefix guard, but the diagnostic message
// would shift and the policy that proof.proofValue is mandatory for
// Ed25519Signature2020 would no longer be locked in at the
// FQ-dispatching site.
func TestVerify_Ed25519_RejectsEmptyProofValue(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)
	signed := signEd25519ForTest(t, priv, pubBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	proof["proofValue"] = ""
	mutated, _ := json.Marshal(doc)

	_, err = Verify(mutated)
	if err == nil {
		t.Fatal("expected verify to fail for empty proofValue")
	}
	if !strings.Contains(err.Error(), "proof.proofValue is required") {
		t.Errorf("err = %v, want it to mention 'proof.proofValue is required'", err)
	}
}

// TestVerify_Ed25519_RejectsInvalidBase58 confirms
// lddataintegrity.DecodeEd25519ProofValue wraps a base58 decode error
// cleanly when the proofValue payload contains non-base58 chars.
// Today this surfaces as "failed to decode proof.proofValue: ...".
// A regression that swallowed the underlying error would still fail
// verification (the bytes wouldn't be 64-long) but the operator-
// facing diagnostic would degrade.
func TestVerify_Ed25519_RejectsInvalidBase58(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)
	signed := signEd25519ForTest(t, priv, pubBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	// 'l' (lowercase L), '0' (zero), 'O' (capital O), 'I' (capital I) are
	// excluded from the Bitcoin base58 alphabet — any of them after the
	// 'z' multibase indicator triggers the decode error path.
	proof["proofValue"] = "z" + "lOOl0lI0"
	mutated, _ := json.Marshal(doc)

	_, err = Verify(mutated)
	if err == nil {
		t.Fatal("expected verify to fail for non-base58 chars in proofValue")
	}
	if !strings.Contains(err.Error(), "failed to decode proof.proofValue") {
		t.Errorf("err = %v, want it to mention 'failed to decode proof.proofValue'", err)
	}
}

// TestVerify_Ed25519_VerificationMethodErrors is a table-driven sweep
// of malformed DIDs the parser rejects. Pins the strictness of
// publicKeyFromVerificationMethod against a regression that loosened
// any single branch (wrong DID method, wrong namespace, truncated
// prefix, empty address segment). The empty-network and case-folding
// branches have their own focused tests; this fills in the rest.
func TestVerify_Ed25519_VerificationMethodErrors(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)
	created := time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC)

	cases := []struct {
		name           string
		method         string
		errorSubstring string
	}{
		{
			name:           "did:key (unsupported DID method)",
			method:         "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
			errorSubstring: "did:pkh:solana",
		},
		{
			name:           "did:pkh with eip155 namespace (wrong chain)",
			method:         "did:pkh:eip155:1:0x1234567890123456789012345678901234567890",
			errorSubstring: "did:pkh:solana",
		},
		{
			name:           "did:pkh:solana: with no rest (missing address segment)",
			method:         "did:pkh:solana:",
			errorSubstring: "missing address segment",
		},
		{
			name:           "did:pkh:solana:devnet: with empty address segment",
			method:         "did:pkh:solana:devnet:",
			errorSubstring: "empty address segment",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			signed := signEd25519WithMethodForTest(t, priv, pubBase58, tc.method, created)
			_, err := Verify(signed)
			if err == nil {
				t.Fatalf("expected verify to fail for verificationMethod %q", tc.method)
			}
			if !strings.Contains(err.Error(), tc.errorSubstring) {
				t.Errorf("err = %v, want it to contain %q", err, tc.errorSubstring)
			}
		})
	}
}

// TestVerify_Ed25519_AcceptsPlusZeroZeroOffset pins the rationale in
// documentForCanonicalization's policy comment as a test invariant: a
// signer that emits proof.created with the explicit `+00:00` offset
// (rather than `Z`) MUST round-trip cleanly. Without this test, a
// regression that reformatted created via time.Time would normalize
// `+00:00` → `Z`, change the canonical bytes, and reject every legitimate
// proof from a producer that uses the explicit-offset form.
func TestVerify_Ed25519_AcceptsPlusZeroZeroOffset(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)

	// Same instant as the other ed25519 tests, but with explicit +00:00.
	created := time.Date(2026, 4, 29, 0, 0, 0, 0, time.FixedZone("UTC+00:00", 0))
	signed := signEd25519WithMethodAndCreatedStringForTest(
		t, priv, pubBase58,
		"did:pkh:solana:devnet:"+pubBase58+"#blockchainAccountId",
		created.Format("2006-01-02T15:04:05.000-07:00"),
	)

	res, err := Verify(signed)
	if err != nil {
		t.Fatalf("verify with +00:00 offset on created: %v", err)
	}
	if !mustEd25519Signer(t, res).PublicKey.Equal(pub) {
		t.Errorf("Ed25519PublicKey mismatch after +00:00 round-trip")
	}
}

// TestVerify_Ed25519_RejectsTruncatedSignature confirms the explicit
// signature-length guard in verifyEd25519 (verify.go:145) actually
// fires. Without this test the branch is dead-coded — a regression that
// dropped the check would still let a 64-byte input through but accept
// 63-byte truncations as well, which ed25519.Verify would then reject
// with the same generic error message and obscure the diagnostic.
func TestVerify_Ed25519_RejectsTruncatedSignature(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)
	signed := signEd25519ForTest(t, priv, pubBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	pv := proof["proofValue"].(string)
	sigBytes, err := base58.Decode(pv[1:])
	if err != nil {
		t.Fatalf("decode proofValue: %v", err)
	}
	// Drop the last byte → 63-byte signature.
	proof["proofValue"] = "z" + base58.Encode(sigBytes[:len(sigBytes)-1])
	mutated, _ := json.Marshal(doc)

	_, err = Verify(mutated)
	if err == nil {
		t.Fatal("expected verify to fail for 63-byte signature")
	}
	if !strings.Contains(err.Error(), "ed25519 signature must be 64 bytes") {
		t.Errorf("err = %v, want it to mention 'ed25519 signature must be 64 bytes'", err)
	}
}

// TestVerify_Ed25519_RejectsExtendedSignature is the upper-bound mirror
// of RejectsTruncatedSignature: a 65-byte signature must also fail the
// length guard rather than silently truncate downstream.
func TestVerify_Ed25519_RejectsExtendedSignature(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)
	signed := signEd25519ForTest(t, priv, pubBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	pv := proof["proofValue"].(string)
	sigBytes, err := base58.Decode(pv[1:])
	if err != nil {
		t.Fatalf("decode proofValue: %v", err)
	}
	// Append one byte → 65-byte signature.
	extended := append(sigBytes, 0x42)
	proof["proofValue"] = "z" + base58.Encode(extended)
	mutated, _ := json.Marshal(doc)

	_, err = Verify(mutated)
	if err == nil {
		t.Fatal("expected verify to fail for 65-byte signature")
	}
	if !strings.Contains(err.Error(), "ed25519 signature must be 64 bytes") {
		t.Errorf("err = %v, want it to mention 'ed25519 signature must be 64 bytes'", err)
	}
}

// TestVerify_Ed25519_RejectsBadAddressLength confirms the pubkey-size
// guard in publicKeyFromVerificationMethod (verify.go:275) fires for a
// DID whose base58 payload decodes to ≠32 bytes. Without this test, a
// future DID parser regression that accepted variable-length payloads
// could pass arbitrary bytes to ed25519.Verify, which only accepts
// 32-byte pubkeys but would yield a less-informative failure.
func TestVerify_Ed25519_RejectsBadAddressLength(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	// 16 random bytes — valid base58, wrong length for an ed25519 pubkey.
	shortPubBytes := make([]byte, 16)
	if _, err := rand.Read(shortPubBytes); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	shortPubBase58 := base58.Encode(shortPubBytes)

	signed := signEd25519WithMethodForTest(
		t, priv, shortPubBase58,
		"did:pkh:solana:devnet:"+shortPubBase58+"#blockchainAccountId",
		time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC),
	)

	_, err = Verify(signed)
	if err == nil {
		t.Fatal("expected verify to fail for ≠32-byte pubkey")
	}
	if !strings.Contains(err.Error(), "decoded pubkey is") {
		t.Errorf("err = %v, want it to mention 'decoded pubkey is'", err)
	}
}

// TestVerify_Ed25519_RejectsTamperedDocument is the load-bearing
// adversarial test: sign a quote, then mutate a top-level document field
// (source_amount) post-sign and confirm verification fails. Without this
// test, a regression where the verifier trusts pre-parsed fields instead
// of re-canonicalizing from raw bytes would silently pass everything else
// in the suite.
func TestVerify_Ed25519_RejectsTamperedDocument(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)
	signed := signEd25519ForTest(t, priv, pubBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	// Confirm the unmutated quote verifies — a regression in the helper
	// or the verifier would otherwise make this test trivially pass.
	if _, err := Verify(signed); err != nil {
		t.Fatalf("baseline verify of untampered quote: %v", err)
	}

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["source_amount"] != "1000000" {
		t.Fatalf("fixture changed: source_amount = %v, want 1000000", doc["source_amount"])
	}
	doc["source_amount"] = "100000000" // shift two zeros — adversarial inflation
	mutated, _ := json.Marshal(doc)

	if _, err := Verify(mutated); err == nil {
		t.Fatal("expected verify to fail for tampered source_amount")
	}
}

// TestVerify_Ed25519_RejectsTamperedProofCreated confirms that mutating a
// proof-options field (created) after signing breaks verification. This
// pins documentForCanonicalization's rawString policy as a security
// invariant — if a future refactor read created from the typed parse
// instead of the raw map, the canonicalized proofOptions would no longer
// match what the signer hashed and verification would fail open on the
// reverse case (legitimate proofs rejected). This test catches the
// forward case (tampering accepted), which is the dangerous direction.
func TestVerify_Ed25519_RejectsTamperedProofCreated(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)
	signed := signEd25519ForTest(t, priv, pubBase58, time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC))

	if _, err := Verify(signed); err != nil {
		t.Fatalf("baseline verify of untampered quote: %v", err)
	}

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	// Replace created with a different valid RFC3339 timestamp; the
	// proofOptions canonicalization will produce different bytes, so
	// the ed25519 signature won't match.
	proof["created"] = "2027-01-01T00:00:00.000Z"
	mutated, _ := json.Marshal(doc)

	if _, err := Verify(mutated); err == nil {
		t.Fatal("expected verify to fail for tampered proof.created")
	}
}

// TestVerify_Ed25519_RejectsEmptyNetworkSegment confirms the verifier
// rejects malformed DIDs with an empty network segment
// (`did:pkh:solana::PUBKEY`). The segment isn't required for ed25519
// verification, but accepting empty would let a producer/attacker
// emit ambiguous identifiers.
func TestVerify_Ed25519_RejectsEmptyNetworkSegment(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)

	signed := signEd25519WithMethodForTest(
		t, priv, pubBase58,
		"did:pkh:solana::"+pubBase58+"#blockchainAccountId",
		time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC),
	)

	_, err = Verify(signed)
	if err == nil {
		t.Fatal("expected verify to fail for empty network segment")
	}
	if !strings.Contains(err.Error(), "empty network segment") {
		t.Errorf("err = %v, want it to mention 'empty network segment'", err)
	}
}

func signEd25519ForTest(t *testing.T, priv ed25519.PrivateKey, pubBase58 string, created time.Time) []byte {
	t.Helper()
	method := "did:pkh:solana:devnet:" + pubBase58 + "#blockchainAccountId"
	return signEd25519WithMethodForTest(t, priv, pubBase58, method, created)
}

// signEd25519WithMethodForTest is signEd25519ForTest with the
// verificationMethod made caller-controlled, so negative tests can
// exercise the DID parser's strictness (case sensitivity, empty
// network, malformed prefix) independently of the rest of the signing
// pipeline.
func signEd25519WithMethodForTest(t *testing.T, priv ed25519.PrivateKey, pubBase58, verificationMethod string, created time.Time) []byte {
	t.Helper()
	return signEd25519WithMethodAndCreatedStringForTest(
		t, priv, pubBase58, verificationMethod,
		created.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
	)
}

// signEd25519WithMethodAndCreatedStringForTest exposes the createdStr
// verbatim — used by tests that need to drive the canonicalization
// pipeline with non-Z UTC forms (e.g. explicit `+00:00` offset) to
// verify the rawString-from-proof policy holds.
func signEd25519WithMethodAndCreatedStringForTest(t *testing.T, priv ed25519.PrivateKey, pubBase58, verificationMethod, createdStr string) []byte {
	t.Helper()

	const (
		fulfillmentQuoteCtx = "https://schemas.atum.network/declarations/FulfillmentQuote/v1/context.jsonld"
		ed25519Ctx          = "https://w3id.org/security/suites/ed25519-2020/v1"
	)

	doc := map[string]any{
		"@context":       []any{fulfillmentQuoteCtx, ed25519Ctx},
		"version":        "1.0",
		"source_amount":  "1000000",
		"award_deadline": "2030-01-01T00:00:00Z",
		"source": map[string]any{
			"id":      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
			"account": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:" + pubBase58,
		},
		"destination": map[string]any{
			"id":      "eip155:1/erc20:0xbbb",
			"account": "eip155:1:0x2",
		},
		"settler_address":      pubBase58,
		"payment_request_json": `{"request_id":"req-sol-1"}`,
	}

	hash, err := HashQuote(doc, HashQuoteOptions{
		Cryptosuite: ProofTypeEd25519Signature2020,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeEd25519Signature2020,
			Created:            createdStr,
			VerificationMethod: verificationMethod,
			ProofPurpose:       "assertionMethod",
			Context:            ed25519Ctx,
		},
	})
	if err != nil {
		t.Fatalf("hash: %v", err)
	}

	sig := ed25519.Sign(priv, hash.SigningInput)
	proofValue := "z" + base58.Encode(sig)

	signed := map[string]any{
		"@context":             []any{fulfillmentQuoteCtx, ed25519Ctx},
		"version":              doc["version"],
		"source_amount":        doc["source_amount"],
		"award_deadline":       doc["award_deadline"],
		"source":               doc["source"],
		"destination":          doc["destination"],
		"settler_address":      doc["settler_address"],
		"payment_request_json": doc["payment_request_json"],
		"verifiableCredential": []any{},
		"proof": map[string]any{
			"type":               ProofTypeEd25519Signature2020,
			"created":            createdStr,
			"verificationMethod": verificationMethod,
			"proofPurpose":       "assertionMethod",
			"proofValue":         proofValue,
		},
	}
	out, err := json.Marshal(signed)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// Sanity: verificationMethod that doesn't decode to 32 bytes should
	// have failed earlier in this helper, not silently emit garbage.
	if !strings.Contains(string(out), pubBase58) {
		t.Fatalf("output missing pubkey base58")
	}
	return out
}
