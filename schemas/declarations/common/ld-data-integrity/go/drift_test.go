package lddataintegrity

import (
	"testing"
)

// TestW3CVCv1MinimalTwinMatchesFull is the load-bearing drift guard:
// canonicalizing a representative MVP VC under the inline minimal
// twin (the active resolver entry) MUST produce byte-identical
// n-quads to canonicalizing under the full vendored W3C VC v1
// snapshot.
//
// Why it matters:
//   - The active resolver entry uses the minimal twin (not the full
//     snapshot) because the full snapshot's `@protected: true`
//     nested scoped contexts collide with VP envelopes that redefine
//     proof / holder / verifiableCredential at outer scope.
//   - The issuer historically registered the FULL snapshot, while
//     FQ registered the MINIMAL twin. The two would silently diverge
//     for any VC shape using a term the twin doesn't bind
//     (credentialSchema, evidence, validFrom, etc.) — the issuer's
//     n-quads wouldn't match the verifier's reconstruction, and
//     signature recovery would fail with a non-obvious "bad
//     signature" error.
//   - This test catches that drift the moment it would manifest. If
//     this test fails, EITHER the minimal twin is missing a term
//     used by the test VC (fix the twin) OR the full snapshot changed
//     (re-vendor + re-confirm the twin still covers prod usage).
//
// Test fixture rationale: the VC shape mirrors a
// KnownToAtumVerifiableCredential as currently issued by
// the issuer — the production VC type today. If a new VC type
// adds an unbound term, expand this fixture to cover it; the test
// failure surfaces the work clearly.
func TestW3CVCv1MinimalTwinMatchesFull(t *testing.T) {
	// Representative VC: MVP KnownToAtumVerifiableCredential shape
	// extended with the union of W3C VC v1 optional terms a future
	// consumer might add (credentialSchema, credentialStatus,
	// evidence, expirationDate, validFrom, validUntil, refreshService,
	// termsOfUse, issued). Each new term added to the twin in
	// document_loader.go MUST appear here so the drift guard
	// exercises it; conversely, a future term needed by any consumer
	// MUST be added to both the twin and this fixture before
	// production canonicalization can rely on it.
	vc := map[string]any{
		"@context": []any{
			W3CVCV1ContextURL,
			KnownToAtumV1ContextURL,
		},
		"id":             "urn:uuid:00000000-0000-0000-0000-000000000001",
		"type":           []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
		"issuer":         "did:web:atumlabs.xyz",
		"issuanceDate":   "2026-01-01T00:00:00Z",
		"expirationDate": "2027-01-01T00:00:00Z",
		"validFrom":      "2026-01-01T00:00:00Z",
		"validUntil":     "2027-01-01T00:00:00Z",
		"issued":         "2026-01-01T00:00:00Z",
		// URI-string values for terms whose snapshot binding has a
		// nested @context — the URI-string canonicalization path
		// only exercises the @type:@id binding, which the twin
		// covers. An object-value fixture (e.g. credentialSchema
		// being {"id":"...","type":"JsonSchemaValidator2018"}) would
		// require binding the nested @context in the twin too;
		// out of scope until any consumer needs that shape.
		"credentialSchema": "https://schemas.atum.network/schema/known-to-atum/v1",
		"credentialStatus": "urn:status:active",
		"evidence":         "urn:evidence:none",
		"refreshService":   "https://refresh.atumlabs.xyz/v1",
		"termsOfUse":       "https://terms.atumlabs.xyz/v1",
		"credentialSubject": map[string]any{
			"id":   "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
			"role": "settler",
		},
	}

	twinLoader := NewDocumentLoader(nil)
	twinNQuads, err := Canonicalize(vc, twinLoader)
	if err != nil {
		t.Fatalf("canonicalize VC under minimal twin: %v", err)
	}

	fullLoader := NewDocumentLoader(map[string]any{
		W3CVCV1ContextURL: w3cVCv1FullVendoredSnapshot(),
	})
	fullNQuads, err := Canonicalize(vc, fullLoader)
	if err != nil {
		t.Fatalf("canonicalize VC under full vendored snapshot: %v", err)
	}

	if twinNQuads != fullNQuads {
		t.Errorf("W3C VC v1 drift: minimal twin and full vendored snapshot produce DIFFERENT canonical n-quads for the MVP VC fixture.\n"+
			"Either the minimal twin is missing a term the fixture uses, OR the full snapshot was re-vendored without re-confirming the twin still covers prod usage.\n\n"+
			"--- minimal twin n-quads ---\n%s\n--- full snapshot n-quads ---\n%s", twinNQuads, fullNQuads)
	}
}
