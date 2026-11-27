package ldverification

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

// fixtureQuote returns a deterministic FulfillmentQuote map suitable for
// driving HashQuote. Kept in one place so a regression in the canonical
// shape lands in a single failure rather than scattered ones.
//
// `version` is omitted on purpose: it gives TestHashQuote_VersionParticipatesInHash
// a clean baseline to diff against. The test below uses fixtureQuoteWithVersion
// to prove the @context binding for the version field carries the version triple
// through URDNA2015 and into the signing input.
func fixtureQuote() map[string]any {
	return map[string]any{
		"source_amount":  "1000000",
		"award_deadline": "2030-01-01T00:00:00Z",
		"source": map[string]any{
			"id":      "eip155:1/erc20:0xaaa",
			"account": "eip155:1:0x1",
		},
		"destination": map[string]any{
			"id":      "eip155:1/erc20:0xbbb",
			"account": "eip155:1:0x2",
		},
		"settler_address":      "0xsettler",
		"payment_request_json": `{"request_id":"req-1"}`,
	}
}

// fixtureQuoteWithVersion is fixtureQuote + `version: "1.0"`. Earlier
// the FulfillmentQuote @context did not bind `atum:version`, so URDNA2015
// silently dropped this field — a failure mode where cross-stack signer
// recovery returned a random-looking address because the verifier's
// canonical hash differed from the signer's. With the binding now live,
// this fixture's hash MUST differ from fixtureQuote()'s; the dedicated
// test below pins exactly that.
func fixtureQuoteWithVersion() map[string]any {
	q := fixtureQuote()
	q["version"] = "1.0"
	return q
}

func fixtureSecp256k1ProofOpts() HashableProofOptions {
	return HashableProofOptions{
		Type:               ProofTypeSecp256k1Recovery2020,
		Created:            "2026-04-01T00:00:00.000Z",
		VerificationMethod: "did:pkh:eip155:1:0xabc#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
	}
}

func fixtureEd25519ProofOpts() HashableProofOptions {
	return HashableProofOptions{
		Type:               ProofTypeEd25519Signature2020,
		Created:            "2026-04-01T00:00:00.000Z",
		VerificationMethod: "did:pkh:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:5fhUhdoXJ24Kk8X3kZw4DqZsbpoeD3RKj5RX7CY4hH5h#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
	}
}

// TestHashQuote_Determinism is the load-bearing invariant of the helper:
// the same input MUST produce the same signing input every call. Anything
// that broke this — non-deterministic canonicalization, accidental
// time-injection, map-iteration leakage — would silently shift the
// signing surface and break verification across the network.
func TestHashQuote_Determinism(t *testing.T) {
	t.Run("secp256k1", func(t *testing.T) {
		a, err := HashQuote(fixtureQuote(), HashQuoteOptions{
			Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: fixtureSecp256k1ProofOpts(),
		})
		if err != nil {
			t.Fatalf("hash #1: %v", err)
		}
		b, err := HashQuote(fixtureQuote(), HashQuoteOptions{
			Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: fixtureSecp256k1ProofOpts(),
		})
		if err != nil {
			t.Fatalf("hash #2: %v", err)
		}
		if !bytes.Equal(a.SigningInput, b.SigningInput) {
			t.Fatalf("non-deterministic SigningInput: %x vs %x", a.SigningInput, b.SigningInput)
		}
		if !bytes.Equal(a.DocHash, b.DocHash) || !bytes.Equal(a.ProofHash, b.ProofHash) {
			t.Fatal("non-deterministic intermediate hashes")
		}
	})
	t.Run("ed25519", func(t *testing.T) {
		a, err := HashQuote(fixtureQuote(), HashQuoteOptions{
			Cryptosuite: ProofTypeEd25519Signature2020, ProofOptions: fixtureEd25519ProofOpts(),
		})
		if err != nil {
			t.Fatalf("hash #1: %v", err)
		}
		b, err := HashQuote(fixtureQuote(), HashQuoteOptions{
			Cryptosuite: ProofTypeEd25519Signature2020, ProofOptions: fixtureEd25519ProofOpts(),
		})
		if err != nil {
			t.Fatalf("hash #2: %v", err)
		}
		if !bytes.Equal(a.SigningInput, b.SigningInput) {
			t.Fatalf("non-deterministic SigningInput: %x vs %x", a.SigningInput, b.SigningInput)
		}
	})
}

// TestHashQuote_OutputShape pins the per-cryptosuite byte-length contract.
// Cross-language fixture lock (matching hex against the TS twin) is a
// follow-up once the TS package has a test runner wired; until then this
// pins the in-language shape so a refactor can't silently swap the hash
// algorithm or composition order.
func TestHashQuote_OutputShape(t *testing.T) {
	tests := []struct {
		name            string
		suite           string
		proofOpts       HashableProofOptions
		wantDocLen      int
		wantProofLen    int
		wantSigInputLen int
	}{
		{
			name:            "secp256k1: keccak256 yields 32-byte hashes; combined keccak256 yields 32-byte SigningInput",
			suite:           ProofTypeSecp256k1Recovery2020,
			proofOpts:       fixtureSecp256k1ProofOpts(),
			wantDocLen:      32,
			wantProofLen:    32,
			wantSigInputLen: 32,
		},
		{
			name:            "ed25519: SHA-256 yields 32-byte hashes; raw concat yields 64-byte SigningInput",
			suite:           ProofTypeEd25519Signature2020,
			proofOpts:       fixtureEd25519ProofOpts(),
			wantDocLen:      32,
			wantProofLen:    32,
			wantSigInputLen: 64,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res, err := HashQuote(fixtureQuote(), HashQuoteOptions{Cryptosuite: tc.suite, ProofOptions: tc.proofOpts})
			if err != nil {
				t.Fatalf("HashQuote: %v", err)
			}
			if res.Cryptosuite != tc.suite {
				t.Errorf("Cryptosuite = %q, want %q", res.Cryptosuite, tc.suite)
			}
			if len(res.DocHash) != tc.wantDocLen {
				t.Errorf("len(DocHash) = %d, want %d", len(res.DocHash), tc.wantDocLen)
			}
			if len(res.ProofHash) != tc.wantProofLen {
				t.Errorf("len(ProofHash) = %d, want %d", len(res.ProofHash), tc.wantProofLen)
			}
			if len(res.SigningInput) != tc.wantSigInputLen {
				t.Errorf("len(SigningInput) = %d, want %d", len(res.SigningInput), tc.wantSigInputLen)
			}
		})
	}
}

// TestHashQuote_CryptosuiteDiscrimination guards against a refactor that
// accidentally produces the same SigningInput across both cryptosuites
// (e.g. a switch fallthrough). The two suites canonicalize against
// different proof contexts AND use different hash primitives, so their
// outputs MUST differ for the same input.
func TestHashQuote_CryptosuiteDiscrimination(t *testing.T) {
	q := fixtureQuote()
	secp, err := HashQuote(q, HashQuoteOptions{Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: fixtureSecp256k1ProofOpts()})
	if err != nil {
		t.Fatalf("secp256k1 hash: %v", err)
	}
	ed, err := HashQuote(q, HashQuoteOptions{Cryptosuite: ProofTypeEd25519Signature2020, ProofOptions: fixtureEd25519ProofOpts()})
	if err != nil {
		t.Fatalf("ed25519 hash: %v", err)
	}
	if bytes.Equal(secp.SigningInput, ed.SigningInput) {
		t.Fatal("secp256k1 and ed25519 produced identical SigningInput — cryptosuite branch is collapsed")
	}
}

// TestHashQuote_RejectsUnsupportedCryptosuite confirms a typo or unknown
// suite fails closed rather than producing a hash under some default.
// Wraps ErrUnsupportedProofType so callers can dispatch by sentinel.
func TestHashQuote_RejectsUnsupportedCryptosuite(t *testing.T) {
	_, err := HashQuote(fixtureQuote(), HashQuoteOptions{
		Cryptosuite:  "EcdsaSecp256k1Signature2019",
		ProofOptions: HashableProofOptions{Type: "EcdsaSecp256k1Signature2019"},
	})
	if err == nil {
		t.Fatal("expected error for unsupported cryptosuite")
	}
	if !errors.Is(err, ErrUnsupportedProofType) {
		t.Fatalf("err = %v, want wraps ErrUnsupportedProofType", err)
	}
}

// TestHashQuote_RejectsTypeCryptosuiteMismatch is the typo guard:
// proofOptions.type MUST equal cryptosuite. Without this the proof
// block would be canonicalized under one IRI while the signer/verifier
// thinks it's another, producing a signing input no one else reconstructs.
func TestHashQuote_RejectsTypeCryptosuiteMismatch(t *testing.T) {
	po := fixtureSecp256k1ProofOpts()
	po.Type = ProofTypeEd25519Signature2020 // mismatch
	_, err := HashQuote(fixtureQuote(), HashQuoteOptions{
		Cryptosuite:  ProofTypeSecp256k1Recovery2020,
		ProofOptions: po,
	})
	if err == nil {
		t.Fatal("expected error for type/cryptosuite mismatch")
	}
	if !errors.Is(err, ErrMalformedProof) {
		t.Fatalf("err = %v, want wraps ErrMalformedProof", err)
	}
}

// TestHashQuote_StripsProofAndVerifiableCredential proves the input
// strip is load-bearing: feeding HashQuote a quote with a stale proof
// block MUST produce the same SigningInput as the equivalent stripped
// quote. Without the strip, a re-sign caller would canonicalize the
// stale proof's predicates into the hash and produce bytes no signer
// or verifier on the network would reconstruct.
func TestHashQuote_StripsProofAndVerifiableCredential(t *testing.T) {
	bare := fixtureQuote()
	withCarryover := fixtureQuote()
	withCarryover["proof"] = map[string]any{
		"type":               "EcdsaSecp256k1RecoverySignature2020",
		"created":            "1999-01-01T00:00:00Z",
		"verificationMethod": "did:example:stale",
		"proofPurpose":       "assertionMethod",
		"jws":                "stale..signature",
	}
	withCarryover["verifiableCredential"] = []any{}

	a, err := HashQuote(bare, HashQuoteOptions{Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: fixtureSecp256k1ProofOpts()})
	if err != nil {
		t.Fatalf("bare: %v", err)
	}
	b, err := HashQuote(withCarryover, HashQuoteOptions{Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: fixtureSecp256k1ProofOpts()})
	if err != nil {
		t.Fatalf("withCarryover: %v", err)
	}
	if !bytes.Equal(a.SigningInput, b.SigningInput) {
		t.Fatalf("strip regression: bare SigningInput=%x, withCarryover=%x", a.SigningInput, b.SigningInput)
	}
}

// TestHashQuote_TamperingChangesHash is the security pin: any change to
// a load-bearing field MUST alter SigningInput, otherwise downstream
// callers' tamper-detection invariants would silently fail-open. We
// already cover end-to-end tamper rejection at the Verify level; this
// pins the boundary at HashQuote itself so a refactor that moved
// canonicalization without re-running the verifier suite would still
// fail loud.
func TestHashQuote_TamperingChangesHash(t *testing.T) {
	base, err := HashQuote(fixtureQuote(), HashQuoteOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: fixtureSecp256k1ProofOpts(),
	})
	if err != nil {
		t.Fatalf("baseline: %v", err)
	}

	cases := []struct {
		name   string
		mutate func(map[string]any, *HashableProofOptions)
	}{
		{"mutate source_amount", func(q map[string]any, _ *HashableProofOptions) { q["source_amount"] = "999" }},
		{"mutate award_deadline", func(q map[string]any, _ *HashableProofOptions) { q["award_deadline"] = "2099-12-31T23:59:59Z" }},
		{"mutate settler_address", func(q map[string]any, _ *HashableProofOptions) { q["settler_address"] = "0xother" }},
		{"mutate proof.created", func(_ map[string]any, p *HashableProofOptions) { p.Created = "2099-01-01T00:00:00Z" }},
		{"mutate proof.verificationMethod", func(_ map[string]any, p *HashableProofOptions) {
			p.VerificationMethod = "did:pkh:eip155:1:0xother#blockchainAccountId"
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q := fixtureQuote()
			p := fixtureSecp256k1ProofOpts()
			tc.mutate(q, &p)
			res, err := HashQuote(q, HashQuoteOptions{Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: p})
			if err != nil {
				t.Fatalf("mutated: %v", err)
			}
			if bytes.Equal(base.SigningInput, res.SigningInput) {
				t.Fatalf("%s: SigningInput unchanged after tamper", tc.name)
			}
		})
	}
}

// TestHashQuote_ProofContextOverridePreservesByteIdentity proves the
// verbatim-@context pass-through is operative: when a caller supplies a
// proof context that's STRUCTURALLY different from the canonical IRI
// (e.g. a single-element array of the same URL), URDNA2015 normalizes
// to the same n-quads — but only because HashQuote forwarded the value
// rather than substituting a synthesized default. A regression that
// re-hardcoded the IRI would also pass this if the wire form happens to
// equal the canonical default, so we test with a deliberately non-default
// (but valid) shape.
func TestHashQuote_ProofContextOverridePreservesByteIdentity(t *testing.T) {
	popts := fixtureSecp256k1ProofOpts()
	canonical, err := HashQuote(fixtureQuote(), HashQuoteOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: popts,
	})
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}

	// Array form of the same canonical IRI. URDNA2015 treats this as
	// equivalent to the string form for this single-context case, so the
	// hash MUST match. If HashQuote silently substituted the canonical
	// default instead of forwarding the array, the hash would still match
	// — so the inverse test below (a different IRI shape) is what proves
	// pass-through, not equality.
	popts.Context = []any{secp256k1Recovery2020V2CtxURL}
	matched, err := HashQuote(fixtureQuote(), HashQuoteOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: popts,
	})
	if err != nil {
		t.Fatalf("array form: %v", err)
	}
	if !bytes.Equal(canonical.SigningInput, matched.SigningInput) {
		t.Fatal("array form of canonical IRI produced a different hash — URDNA2015 equivalence regressed")
	}

	// Different IRI entirely — should produce a different hash. This is
	// the proof that the Context value flows through to canonicalize
	// rather than being silently replaced.
	popts.Context = "https://w3id.org/security/v2"
	if _, err := HashQuote(fixtureQuote(), HashQuoteOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: popts,
	}); err == nil {
		// canonicalize would fail because this IRI isn't in the embedded
		// context store. We expect the error path here, which itself
		// proves the value was forwarded (a silent replacement would
		// have succeeded).
		t.Fatal("expected canonicalize error for unknown proof @context — pass-through regressed")
	} else if !strings.Contains(err.Error(), "https://w3id.org/security/v2") {
		// Be specific: any error that doesn't reference the unknown
		// context URL could mask a different regression. json-gold
		// wraps the shared lib's document-loader error inside its own
		// "Dereferencing a URL did not result in a valid JSON-LD
		// context" envelope, so we match on the URL we passed
		// through rather than on the loader's verbatim message.
		t.Fatalf("err = %v, want canonicalize-side error referencing the unknown @context URL", err)
	}
}

// TestHashQuote_VersionParticipatesInHash pins the version binding: the
// FulfillmentQuote @context now binds `atum:version`, so a document with
// a version field MUST hash differently than the equivalent document
// without one. The inverse — equal hashes — would mean URDNA2015 dropped
// the field, the exact mode that surfaced on the agent side and the
// reason the drift check exists. This test catches the canonicalization
// side directly, with no cross-repo coupling.
//
// Run against both cryptosuites because the version field lives in the
// document, not the proof block: a regression that only affected one
// suite's document-hashing path would slip past a single-suite test.
func TestHashQuote_VersionParticipatesInHash(t *testing.T) {
	t.Run("secp256k1", func(t *testing.T) {
		baseline, err := HashQuote(fixtureQuote(), HashQuoteOptions{
			Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: fixtureSecp256k1ProofOpts(),
		})
		if err != nil {
			t.Fatalf("baseline: %v", err)
		}
		withVersion, err := HashQuote(fixtureQuoteWithVersion(), HashQuoteOptions{
			Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: fixtureSecp256k1ProofOpts(),
		})
		if err != nil {
			t.Fatalf("withVersion: %v", err)
		}
		if bytes.Equal(baseline.SigningInput, withVersion.SigningInput) {
			t.Fatal("version field did not change SigningInput — @context binding for atum:version regressed")
		}
	})
	t.Run("ed25519", func(t *testing.T) {
		baseline, err := HashQuote(fixtureQuote(), HashQuoteOptions{
			Cryptosuite: ProofTypeEd25519Signature2020, ProofOptions: fixtureEd25519ProofOpts(),
		})
		if err != nil {
			t.Fatalf("baseline: %v", err)
		}
		withVersion, err := HashQuote(fixtureQuoteWithVersion(), HashQuoteOptions{
			Cryptosuite: ProofTypeEd25519Signature2020, ProofOptions: fixtureEd25519ProofOpts(),
		})
		if err != nil {
			t.Fatalf("withVersion: %v", err)
		}
		if bytes.Equal(baseline.SigningInput, withVersion.SigningInput) {
			t.Fatal("version field did not change SigningInput — @context binding for atum:version regressed")
		}
	})
}
