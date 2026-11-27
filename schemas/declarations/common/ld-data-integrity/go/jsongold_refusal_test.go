package lddataintegrity

import (
	"errors"
	"strings"
	"testing"

	"github.com/piprate/json-gold/ld"
)

type jsonGoldRefusedDocument struct {
	name string
	json string
	// code is the json-gold error code the document is known to draw, so the
	// premise guard proves the refusal is the intended one and not some other
	// error the document happens to trigger.
	code ld.ErrorCode
}

// jsonGoldRefusedDocuments pass every admission rule, do not make json-gold
// panic, and do not name an unregistered context, yet json-gold returns an
// error while converting them to RDF. They are malformed caller input, not a
// fault of the server processing them.
func jsonGoldRefusedDocuments() []jsonGoldRefusedDocument {
	return []jsonGoldRefusedDocument{
		{
			// The credentials context protects its terms; a nested node whose own
			// context is a registered context defining one of them differently
			// asks json-gold to redefine a protected term.
			name: "a nested context redefining a protected term",
			json: `{"@context":"` + W3CVCV1ContextURL + `","credentialSubject":{"@context":"` + datasetPaymentRequestContextURL + `"}}`,
			code: ld.ProtectedTermRedefinition,
		},
		{
			// json-gold treats a registered context listed twice as a context
			// including itself.
			name: "a registered context listed twice",
			json: `{"@context":["` + W3CVCV1ContextURL + `","` + W3CVCV1ContextURL + `"],"id":"urn:x"}`,
			code: ld.RecursiveContextInclusion,
		},
	}
}

// Guards the premise: each document is admitted and draws the named error
// from bare json-gold without a panic. Should an upgrade accept a document,
// this fails and the classification test below no longer exercises
// json-gold's error path.
func TestJSONGold_ToRDFRefusesAdmittedDocuments(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	for _, d := range jsonGoldRefusedDocuments() {
		t.Run(d.name, func(t *testing.T) {
			doc := parseJSONDocument(t, d.json)
			if err := CheckCanonicalizable(copyJSON(t, doc)); err != nil {
				t.Fatalf("CheckCanonicalizable = %v, want admission: the document must reach json-gold", err)
			}
			var err error
			panicked := func() (r any) {
				defer func() { r = recover() }()
				_, err = ld.NewJsonLdProcessor().ToRDF(copyJSON(t, doc), jsonGoldOptions(loader))
				return nil
			}()
			if panicked != nil {
				t.Fatalf("json-gold ToRDF panicked with %v, want an error: a panic is a different class", panicked)
			}
			var jerr *ld.JsonLdError
			if !errors.As(err, &jerr) {
				t.Fatalf("json-gold ToRDF err = %v, want a *ld.JsonLdError", err)
			}
			if jerr.Code != d.code {
				t.Errorf("json-gold error code = %q, want %q", jerr.Code, d.code)
			}
		})
	}
}

// json-gold refusing an admitted document while converting it to a dataset,
// here over a protected-term redefinition or a recursive context inclusion,
// means the caller sent JSON-LD the library cannot process, so the refusal
// carries the same sentinel as a contained panic and callers can answer it as
// malformed input. json-gold's own error stays in the chain for the operator
// diagnosing which rule of JSON-LD processing the document broke.
func TestCanonicalize_JSONGoldRefusingAnAdmittedDocumentIsErrCanonicalizationFailed(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	for _, d := range jsonGoldRefusedDocuments() {
		t.Run(d.name, func(t *testing.T) {
			out, panicked, err := canonicalizeRecovering(parseJSONDocument(t, d.json), loader)
			if panicked != nil {
				t.Fatalf("Canonicalize panicked with %v, want an error matching ErrCanonicalizationFailed", panicked)
			}
			if out != "" {
				t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
			}
			if err == nil {
				t.Fatal("err = nil, want an error matching ErrCanonicalizationFailed")
			}
			if !errors.Is(err, ErrCanonicalizationFailed) {
				t.Errorf("errors.Is(err, ErrCanonicalizationFailed) = false for %v", err)
			}
			// Every context the document names is registered.
			if errors.Is(err, ErrUnknownContext) {
				t.Errorf("errors.Is(err, ErrUnknownContext) = true for %v, want false", err)
			}
			if errors.Is(err, ErrNotCanonicalizable) {
				t.Errorf("errors.Is(err, ErrNotCanonicalizable) = true for %v, want false", err)
			}
			var ae *AdmissionError
			if errors.As(err, &ae) {
				t.Errorf("errors.As(err, *AdmissionError) = true ({Rule: %q, Path: %q}), want false", ae.Rule, ae.Path)
			}
			var jerr *ld.JsonLdError
			if !errors.As(err, &jerr) {
				t.Fatalf("errors.As(err, *ld.JsonLdError) = false for %v, want json-gold's error kept in the chain", err)
			}
			if jerr.Code != d.code {
				t.Errorf("chained json-gold error code = %q, want %q", jerr.Code, d.code)
			}
		})
	}
}

// json-gold also reports an unregistered context as an error from ToRDF.
// Labelling json-gold's errors must not relabel that one: it keeps its own
// sentinel, and only that one, under the same loader the refused documents
// above are run against.
func TestCanonicalize_UnknownContextIsNotErrCanonicalizationFailed(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	ran := 0
	for _, d := range unknownContextDocuments() {
		// The scoped, chained and importing routes need contexts only the
		// unknown-context loader registers.
		if strings.Contains(d.json, "https://registered.example/") {
			continue
		}
		ran++
		t.Run(d.name, func(t *testing.T) {
			out, panicked, err := canonicalizeRecovering(parseJSONDocument(t, d.json), loader)
			if panicked != nil {
				t.Fatalf("Canonicalize panicked with %v, want an error matching ErrUnknownContext", panicked)
			}
			if out != "" {
				t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
			}
			wantUnknownContext(t, err)
		})
	}
	if ran == 0 {
		t.Fatal("no unknown-context document runs under this loader; the test checks nothing")
	}
}

// A nil loader is a programming error in the caller's wiring, not a property
// of the document, so it must not be reported as a document json-gold could
// not process.
func TestCanonicalize_NilLoaderIsNotErrCanonicalizationFailed(t *testing.T) {
	_, err := Canonicalize(map[string]any{"@context": W3CVCV1ContextURL, "id": "urn:x"}, nil)
	if err == nil {
		t.Fatal("err = nil, want an error for a nil loader")
	}
	for _, s := range []error{ErrCanonicalizationFailed, ErrUnknownContext, ErrNotCanonicalizable} {
		if errors.Is(err, s) {
			t.Errorf("errors.Is(err, %v) = true for %v, want false", s, err)
		}
	}
}
