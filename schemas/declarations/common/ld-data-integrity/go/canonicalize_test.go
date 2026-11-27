package lddataintegrity

import (
	"errors"
	"strings"
	"testing"
)

// TestNewDocumentLoader_GenericContextsResolve pins that the four
// vendored generic contexts (W3C VC v1, secp256k1recovery-2020-v2,
// ed25519-2020-v1, known-to-atum-v1) all load through the
// strict-no-network loader without hitting the unknown-URL branch.
// Catches a vendoring bug at the embed layer the moment it lands.
func TestNewDocumentLoader_GenericContextsResolve(t *testing.T) {
	loader := NewDocumentLoader(nil)
	for _, url := range []string{
		W3CVCV1ContextURL,
		Secp256k1Recovery2020V2CtxURL,
		Ed25519Signature2020V1CtxURL,
		KnownToAtumV1ContextURL,
	} {
		doc, err := loader.LoadDocument(url)
		if err != nil {
			t.Errorf("LoadDocument(%q) returned err = %v; want nil for vendored generic context", url, err)
			continue
		}
		if doc == nil || doc.Document == nil {
			t.Errorf("LoadDocument(%q) returned nil document body", url)
		}
	}
}

// TestNewDocumentLoader_UnknownURLFailsClosed is the load-bearing SSRF
// defense check: any URL not in the loader's registered set MUST fail
// closed with ErrUnknownContext, NOT silently fall through to a network
// fetch. The pre-consolidation FQ impl had this same guard; the
// consolidation must not regress it.
func TestNewDocumentLoader_UnknownURLFailsClosed(t *testing.T) {
	loader := NewDocumentLoader(nil)
	_, err := loader.LoadDocument("https://attacker.example/evil-context.jsonld")
	if err == nil {
		t.Fatal("LoadDocument with unknown URL returned nil err — SSRF defense regressed")
	}
	if !errors.Is(err, ErrUnknownContext) {
		t.Errorf("LoadDocument err = %v, want errors.Is(ErrUnknownContext)", err)
	}
	if !strings.Contains(err.Error(), "attacker.example") {
		t.Errorf("err = %q, want it to include the unknown URL for log diagnostics", err)
	}
}

// TestNewDocumentLoader_ExtraContextsRegister pins the extension API
// schema-specific consumers depend on: caller-supplied `extra` map
// merges with the generic vendored set so e.g. FQ can register its
// FulfillmentQuote-context.jsonld alongside the W3C VC v1 base.
func TestNewDocumentLoader_ExtraContextsRegister(t *testing.T) {
	extraURL := "https://schemas.atum.network/declarations/Example/v1/context.jsonld"
	extraCtx := map[string]any{
		"@context": map[string]any{
			"atum": "https://schemas.atum.network/",
		},
	}
	loader := NewDocumentLoader(map[string]any{extraURL: extraCtx})

	// Caller-registered context resolves.
	doc, err := loader.LoadDocument(extraURL)
	if err != nil {
		t.Fatalf("LoadDocument(%q) err = %v; want nil for extra context", extraURL, err)
	}
	if doc.DocumentURL != extraURL {
		t.Errorf("DocumentURL = %q, want %q", doc.DocumentURL, extraURL)
	}

	// Generic context still resolves alongside.
	if _, err := loader.LoadDocument(W3CVCV1ContextURL); err != nil {
		t.Errorf("Generic W3C VC v1 context not resolvable after extras registered: %v", err)
	}
}

// TestDocumentLoader_WithExtraContexts pins the per-call overlay API.
// A VP verifier overlays an envelope-declaration-specific context onto
// an existing loader for a single canonicalization WITHOUT mutating the
// base loader — the layering boundary depends on the base staying
// pristine across overlays.
func TestDocumentLoader_WithExtraContexts(t *testing.T) {
	base := NewDocumentLoader(nil)
	overlayURL := "https://schemas.atum.network/declarations/PaymentRequestEnvelope/v1/context.jsonld"
	overlayCtx := map[string]any{
		"@context": map[string]any{
			"atum": "https://schemas.atum.network/",
		},
	}

	derived := base.WithExtraContexts(map[string]any{overlayURL: overlayCtx})

	// Derived loader resolves the overlay AND the generic base.
	if _, err := derived.LoadDocument(overlayURL); err != nil {
		t.Errorf("derived loader did not resolve overlay URL %q: %v", overlayURL, err)
	}
	if _, err := derived.LoadDocument(W3CVCV1ContextURL); err != nil {
		t.Errorf("derived loader dropped the generic base context: %v", err)
	}

	// Base loader is NOT mutated — the overlay URL must still fail closed
	// on the base. This is the layering guard: an overlay on a per-call
	// loader can never leak into the shared process-global instance.
	if _, err := base.LoadDocument(overlayURL); !errors.Is(err, ErrUnknownContext) {
		t.Errorf("base loader leaked the overlay URL — WithExtraContexts mutated the receiver; err = %v, want ErrUnknownContext", err)
	}

	// Nil / empty extra returns a distinct instance with the same set.
	same := base.WithExtraContexts(nil)
	if same == base {
		t.Error("WithExtraContexts(nil) returned the receiver itself — callers expect a distinct, independently-mutable instance")
	}
	if _, err := same.LoadDocument(W3CVCV1ContextURL); err != nil {
		t.Errorf("WithExtraContexts(nil) dropped the generic base context: %v", err)
	}
}

// TestCanonicalize_NilLoaderFailsFast pins the defensive nil-loader
// check. A nil loader would fall through to json-gold's default which
// network-fetches contexts — exactly the SSRF surface the lib exists
// to close. Fail fast at the entry point.
func TestCanonicalize_NilLoaderFailsFast(t *testing.T) {
	_, err := Canonicalize(map[string]any{"@context": W3CVCV1ContextURL}, nil)
	if err == nil {
		t.Fatal("Canonicalize with nil loader returned nil err — defensive guard regressed")
	}
	if !strings.Contains(err.Error(), "nil DocumentLoader") {
		t.Errorf("err = %q, want it to mention 'nil DocumentLoader'", err)
	}
}

// TestCanonicalize_W3CVCv1Doc smoke-tests the full canonicalization
// path against a minimal W3C VC v1 document. Doesn't pin specific
// n-quad output (that's the conformance fixtures' job) — just asserts
// the path runs cleanly with the vendored loader.
func TestCanonicalize_W3CVCv1Doc(t *testing.T) {
	loader := NewDocumentLoader(nil)
	doc := map[string]any{
		"@context": []any{W3CVCV1ContextURL},
		"type":     []any{"VerifiableCredential"},
		"issuer":   "did:web:example.com",
	}
	nquads, err := Canonicalize(doc, loader)
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	if nquads == "" {
		t.Error("Canonicalize returned empty n-quads")
	}
}
