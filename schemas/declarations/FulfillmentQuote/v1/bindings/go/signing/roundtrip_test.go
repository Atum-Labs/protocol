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

// TestRoundTrip exercises the full sign→verify path inside this Go module
// so a regression in canonicalization, JWS encoding, or address recovery
// fails here (not only in the cross-language test-signing.sh harness).
// The signing logic mirrors the TypeScript signer byte-for-byte.
func TestRoundTrip(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	expected := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())

	signed := signForTest(t, priv, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

	res, err := Verify(signed)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got := strings.ToLower(mustSecp256k1Signer(t, res).Hex()); got != expected {
		t.Errorf("recovered address = %s, want %s", got, expected)
	}
}

// TestVerify_Secp256k1_RejectsTamperedDocument is the load-bearing
// adversarial test for the secp256k1 cryptosuite: sign a quote, then
// mutate a top-level document field (source_amount) post-sign and
// confirm the recovered address no longer matches the original signer.
//
// Subtle but important: secp256k1 ECDSA recovery is non-failing —
// RecoverAddress always returns SOME address from any signature+hash
// pair. Tampering the document changes the canonical hash, which
// recovers a different address. The bare verifier returns no error;
// the security comes from the downstream verifier comparing the
// recovered address against the verificationMethod DID + whitelist.
// This test pins that the
// recovered address actually differs after tampering — a regression
// where the verifier trusted pre-parsed fields would recover the
// ORIGINAL address despite the tamper, and silently pass everything
// downstream. Symmetric (with the recovery-vs-binary-verify caveat)
// with TestVerify_Ed25519_RejectsTamperedDocument.
func TestVerify_Secp256k1_RejectsTamperedDocument(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	expected := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	signed := signForTest(t, priv, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

	if res, err := Verify(signed); err != nil {
		t.Fatalf("baseline verify of untampered quote: %v", err)
	} else if got := strings.ToLower(mustSecp256k1Signer(t, res).Hex()); got != expected {
		t.Fatalf("baseline recovered = %s, want %s", got, expected)
	}

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["source_amount"] != "1000000" {
		t.Fatalf("fixture changed: source_amount = %v, want 1000000", doc["source_amount"])
	}
	doc["source_amount"] = "100000000"
	mutated, _ := json.Marshal(doc)

	res, err := Verify(mutated)
	if err == nil {
		got := strings.ToLower(mustSecp256k1Signer(t, res).Hex())
		if got == expected {
			t.Fatalf("tampered source_amount recovered the original signer (%s); verifier failed to re-canonicalize from raw bytes", got)
		}
	}
}

// TestCanonicalize_EmitsVersionQuad pins that the `version` declaration
// field actually appears in the URDNA2015 N-Quads output. URDNA2015
// silently drops fields not bound in the active @context, so a regression
// where someone removes the `version` term from
// schemas/declarations/FulfillmentQuote/v1/context.jsonld would let an
// attacker mutate `version` on the wire without invalidating the
// signature. The IRI assertion is the canonicalization-level invariant;
// the signing-level invariant is covered by
// TestVerify_Secp256k1_RejectsTamperedVersion below.
func TestCanonicalize_EmitsVersionQuad(t *testing.T) {
	const fulfillmentQuoteCtx = "https://schemas.atum.network/declarations/FulfillmentQuote/v1/context.jsonld"

	doc := map[string]any{
		"@context":             []any{fulfillmentQuoteCtx},
		"version":              "1.0",
		"source_amount":        "1000000",
		"award_deadline":       "2030-01-01T00:00:00Z",
		"source":               map[string]any{"id": "eip155:1/erc20:0xaaa", "account": "eip155:1:0x1"},
		"destination":          map[string]any{"id": "eip155:1/erc20:0xbbb", "account": "eip155:1:0x2"},
		"settler_address":      "0xabc",
		"payment_request_json": `{"request_id":"req-1"}`,
	}

	quads, err := Canonicalize(doc)
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	const versionIRI = "<https://schemas.atum.network/version>"
	if !strings.Contains(quads, versionIRI) {
		t.Fatalf("canonicalized output missing %s — context.jsonld is not binding the `version` term, signed bytes will silently exclude it. quads:\n%s", versionIRI, quads)
	}
}

// TestVerify_Secp256k1_RejectsTamperedVersion confirms that mutating
// `version` after signing changes the recovered address. The signing
// path uses URDNA2015, which only includes fields bound in the active
// @context; without `version` in the FQ context, an on-wire actor
// could rewrite `version` and the signature would still verify. This
// test fails the moment that gap reopens.
func TestVerify_Secp256k1_RejectsTamperedVersion(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	expected := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	signed := signForTest(t, priv, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

	if res, err := Verify(signed); err != nil {
		t.Fatalf("baseline verify of untampered quote: %v", err)
	} else if got := strings.ToLower(mustSecp256k1Signer(t, res).Hex()); got != expected {
		t.Fatalf("baseline recovered = %s, want %s", got, expected)
	}

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["version"] != "1.0" {
		t.Fatalf("fixture changed: version = %v, want 1.0", doc["version"])
	}
	doc["version"] = "1.99"
	mutated, _ := json.Marshal(doc)

	res, err := Verify(mutated)
	if err == nil {
		got := strings.ToLower(mustSecp256k1Signer(t, res).Hex())
		if got == expected {
			t.Fatalf("tampered version recovered the original signer (%s); the `version` term is not load-bearing for the signature — restore it in schemas/declarations/FulfillmentQuote/v1/context.jsonld", got)
		}
	}
}

// TestVerify_Secp256k1_RejectsTamperedProofCreated confirms that mutating
// proof.created after signing changes the recovered address on the JWS
// path. Pins documentForCanonicalization's rawString policy for the
// secp256k1 cryptosuite as a security invariant. See the comment on
// TestVerify_Secp256k1_RejectsTamperedDocument for why we assert on
// recovered-address-differs rather than verify-returns-error.
func TestVerify_Secp256k1_RejectsTamperedProofCreated(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	expected := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	signed := signForTest(t, priv, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

	if res, err := Verify(signed); err != nil {
		t.Fatalf("baseline verify of untampered quote: %v", err)
	} else if got := strings.ToLower(mustSecp256k1Signer(t, res).Hex()); got != expected {
		t.Fatalf("baseline recovered = %s, want %s", got, expected)
	}

	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	proof["created"] = "2027-01-01T00:00:00.000Z"
	mutated, _ := json.Marshal(doc)

	res, err := Verify(mutated)
	if err == nil {
		got := strings.ToLower(mustSecp256k1Signer(t, res).Hex())
		if got == expected {
			t.Fatalf("tampered proof.created recovered the original signer (%s); rawString-from-proof policy regressed", got)
		}
	}
}

// TestVerify_Secp256k1_RejectsBitFlippedSignature flips one byte of the
// 65-byte signature inside the detached JWS and asserts the verifier
// either rejects the recovery outright or recovers a different address
// (which downstream callers would then fail to match against a
// whitelist). Symmetrizes the existing
// TestVerify_Ed25519_RejectsBadProofValue and closes the gap that
// TestVerify_RejectsMissingJws / RejectsMalformedJws cover only format
// errors, not bit-flipped-but-format-valid signatures.
func TestVerify_Secp256k1_RejectsBitFlippedSignature(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	expected := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	signed := signForTest(t, priv, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

	res, err := Verify(signed)
	if err != nil {
		t.Fatalf("baseline verify of untampered quote: %v", err)
	}
	if got := strings.ToLower(mustSecp256k1Signer(t, res).Hex()); got != expected {
		t.Fatalf("baseline recovered = %s, want %s", got, expected)
	}

	// Pull the JWS out of the signed quote, decode its detached signature,
	// flip a byte, re-encode, splice back in.
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

	// Either Verify errors (e.g. invalid signature) or recovers a
	// different-than-expected address. Both are acceptable outcomes —
	// the contract is "downstream caller cannot mistake this for the
	// original signer". A bit-flip that recovered the SAME address
	// would be the regression we're guarding against.
	res, err = Verify(mutated)
	if err == nil {
		got := strings.ToLower(mustSecp256k1Signer(t, res).Hex())
		if got == expected {
			t.Fatalf("bit-flipped signature recovered the original signer (%s); regression in JWS / recovery path", got)
		}
	}
}

// TestRoundTrip_NonZUTCCreated confirms the verifier accepts the same
// instant expressed as `+00:00` — earlier code reformatted it to `Z`,
// which would have broken canonicalization parity with any signer that
// emitted the explicit-offset form.
func TestRoundTrip_NonZUTCCreated(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	expected := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())

	created := time.Date(2026, 4, 1, 0, 0, 0, 0, time.FixedZone("UTC+00:00", 0))
	signed := signForTestWithCreatedString(t, priv, created.Format("2006-01-02T15:04:05.000-07:00"))

	res, err := Verify(signed)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got := strings.ToLower(mustSecp256k1Signer(t, res).Hex()); got != expected {
		t.Errorf("recovered address = %s, want %s", got, expected)
	}
}

func signForTest(t *testing.T, priv *ecdsa.PrivateKey, created time.Time) []byte {
	t.Helper()
	return signForTestWithCreatedString(t, priv, created.UTC().Format("2006-01-02T15:04:05.000Z07:00"))
}

func signForTestWithCreatedString(t *testing.T, priv *ecdsa.PrivateKey, createdStr string) []byte {
	t.Helper()
	return signQuoteForTest(t, priv, priv, createdStr, false)
}

// signQuoteForTest binds the quote to identity and signs it with signer, over the legacy signing
// input or, when settlerProof is set, over the SettlerProof typed digest.
func signQuoteForTest(t *testing.T, identity, signer *ecdsa.PrivateKey, createdStr string, settlerProof bool) []byte {
	t.Helper()
	priv := identity

	const fulfillmentQuoteCtx = "https://schemas.atum.network/declarations/FulfillmentQuote/v1/context.jsonld"
	const secp256k1RecoveryCtx = "https://w3id.org/security/suites/secp256k1recovery-2020/v2"

	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	doc := map[string]any{
		"@context":             []any{fulfillmentQuoteCtx, secp256k1RecoveryCtx},
		"version":              "1.0",
		"source_amount":        "1000000",
		"award_deadline":       "2030-01-01T00:00:00Z",
		"source":               map[string]any{"id": "eip155:1/erc20:0xaaa", "account": "eip155:1:0x1"},
		"destination":          map[string]any{"id": "eip155:1/erc20:0xbbb", "account": "eip155:1:0x2"},
		"settler_address":      address,
		"payment_request_json": `{"request_id":"req-1"}`,
	}

	verificationMethod := "did:pkh:eip155:1:" + address + "#blockchainAccountId"

	hash, err := HashQuote(doc, HashQuoteOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeSecp256k1Recovery2020,
			Created:            createdStr,
			VerificationMethod: verificationMethod,
			ProofPurpose:       "assertionMethod",
			Context:            secp256k1RecoveryCtx,
		},
	})
	if err != nil {
		t.Fatalf("hash: %v", err)
	}

	sig, err := crypto.Sign(testSigningDigest(t, hash, settlerProof), signer)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	sig[64] += 27 // align with ethers.js / W3C secp256k1recovery v in {27,28}

	header := map[string]any{"alg": "ES256K-R", "b64": false, "crit": []string{"b64"}}
	headerJSON, _ := json.Marshal(header)
	jws := base64.RawURLEncoding.EncodeToString(headerJSON) + ".." + base64.RawURLEncoding.EncodeToString(sig)

	signed := map[string]any{
		"@context":             []any{fulfillmentQuoteCtx, secp256k1RecoveryCtx},
		"version":              doc["version"],
		"source_amount":        doc["source_amount"],
		"award_deadline":       doc["award_deadline"],
		"source":               doc["source"],
		"destination":          doc["destination"],
		"settler_address":      doc["settler_address"],
		"payment_request_json": doc["payment_request_json"],
		"verifiableCredential": []any{},
		"proof": map[string]any{
			"type":               ProofTypeSecp256k1Recovery2020,
			"created":            createdStr,
			"verificationMethod": verificationMethod,
			"proofPurpose":       "assertionMethod",
			"jws":                jws,
		},
	}
	out, err := json.Marshal(signed)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return out
}
