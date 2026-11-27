package lddataintegrity

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/piprate/json-gold/ld"
)

// unknownContextURL is registered by no loader in this file, so every
// reference to it must reach the loader's fail-closed branch.
const unknownContextURL = "https://unregistered.example/ctx.jsonld"

// Contexts registered only by unknownContextLoader. Each one is itself
// admissible to reference by URL, but reaches unknownContextURL while
// json-gold processes it, so the unknown reference is only discovered
// during expansion rather than at the document's top level.
const (
	termScopedContextURL = "https://registered.example/term-scoped.jsonld"
	typeScopedContextURL = "https://registered.example/type-scoped.jsonld"
	chainedContextURL    = "https://registered.example/chained.jsonld"
	importingContextURL  = "https://registered.example/importing.jsonld"
)

func unknownContextLoader() *DocumentLoader {
	return NewDocumentLoader(map[string]any{
		termScopedContextURL: map[string]any{
			"@context": map[string]any{
				"@version": 1.1,
				"wrapper": map[string]any{
					"@id":      "https://registered.example/vocab#wrapper",
					"@context": unknownContextURL,
				},
				"a": "https://registered.example/vocab#a",
			},
		},
		typeScopedContextURL: map[string]any{
			"@context": map[string]any{
				"@version": 1.1,
				"type":     "@type",
				"Scoped": map[string]any{
					"@id":      "https://registered.example/vocab#Scoped",
					"@context": unknownContextURL,
				},
				"a": "https://registered.example/vocab#a",
			},
		},
		chainedContextURL: map[string]any{
			"@context": []any{unknownContextURL},
		},
		importingContextURL: map[string]any{
			"@context": map[string]any{
				"@version": 1.1,
				"@import":  unknownContextURL,
				"a":        "https://registered.example/vocab#a",
			},
		},
	})
}

type unknownContextDocument struct {
	name string
	json string
}

// unknownContextDocuments covers every route by which a document can make the
// loader resolve an unregistered URL: named directly at the top level, as any
// element of a context list, on a nested node, and indirectly through a
// registered context that scopes, chains to, or imports it.
func unknownContextDocuments() []unknownContextDocument {
	return []unknownContextDocument{
		{"a single URL", `{"@context":"` + unknownContextURL + `","a":"b"}`},
		{"the only element of a list", `{"@context":["` + unknownContextURL + `"],"a":"b"}`},
		{"a list element after a registered context", `{"@context":["` + W3CVCV1ContextURL + `","` + unknownContextURL + `"],"type":"VerifiableCredential","issuer":"did:web:example.com"}`},
		{"a list element before a registered context", `{"@context":["` + unknownContextURL + `","` + W3CVCV1ContextURL + `"],"type":"VerifiableCredential","issuer":"did:web:example.com"}`},
		{"a nested node's own context", `{"@context":"` + W3CVCV1ContextURL + `","type":"VerifiableCredential","credentialSubject":{"@context":"` + unknownContextURL + `","id":"urn:subject"}}`},
		{"a term-scoped context", `{"@context":"` + termScopedContextURL + `","wrapper":{"a":"b"}}`},
		{"a type-scoped context", `{"@context":"` + typeScopedContextURL + `","type":"Scoped","a":"b"}`},
		{"a registered context that chains to it", `{"@context":"` + chainedContextURL + `","a":"b"}`},
		{"a registered context that imports it", `{"@context":"` + importingContextURL + `","a":"b"}`},
	}
}

// wantUnknownContext checks the whole contract for a document naming a
// context the loader does not hold: the sentinel survives json-gold so a
// caller can classify it, the URL survives for the operator reading the log,
// and it is not mistaken for either of the library's other refusals.
func wantUnknownContext(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("err = nil, want an error matching ErrUnknownContext")
	}
	if !errors.Is(err, ErrUnknownContext) {
		t.Errorf("errors.Is(err, ErrUnknownContext) = false for %v", err)
	}
	if !strings.Contains(err.Error(), unknownContextURL) {
		t.Errorf("err = %q, want it to name %s", err, unknownContextURL)
	}
	if errors.Is(err, ErrNotCanonicalizable) {
		t.Errorf("errors.Is(err, ErrNotCanonicalizable) = true for %v, want false", err)
	}
	var ae *AdmissionError
	if errors.As(err, &ae) {
		t.Errorf("errors.As(err, *AdmissionError) = true ({Rule: %q, Path: %q}), want false", ae.Rule, ae.Path)
	}
	if errors.Is(err, ErrCanonicalizationFailed) {
		t.Errorf("errors.Is(err, ErrCanonicalizationFailed) = true for %v, want false", err)
	}
}

// Guards the premise: json-gold wraps the loader's error in its own
// *ld.JsonLdError, which does not unwrap, so the sentinel is lost unless
// Canonicalize restores it. Should json-gold start unwrapping, this fails and
// the tests below no longer prove Canonicalize does anything on its own.
func TestJSONGold_LosesTheUnknownContextSentinel(t *testing.T) {
	loader := unknownContextLoader()
	for _, d := range unknownContextDocuments() {
		t.Run(d.name, func(t *testing.T) {
			doc := parseJSONDocument(t, d.json)
			if err := CheckCanonicalizable(copyJSON(t, doc)); err != nil {
				t.Fatalf("CheckCanonicalizable = %v, want admission: the document must reach json-gold", err)
			}
			_, err := ld.NewJsonLdProcessor().ToRDF(copyJSON(t, doc), jsonGoldOptions(loader))
			if err == nil {
				t.Fatal("json-gold ToRDF returned no error; the document never reached the unknown context")
			}
			var jerr *ld.JsonLdError
			if !errors.As(err, &jerr) {
				t.Fatalf("json-gold error %T (%v), want *ld.JsonLdError", err, err)
			}
			if jerr.Code != ld.LoadingRemoteContextFailed {
				t.Errorf("json-gold error code = %q, want %q", jerr.Code, ld.LoadingRemoteContextFailed)
			}
			if !strings.Contains(err.Error(), unknownContextURL) {
				t.Errorf("json-gold error = %q, want it to name %s", err, unknownContextURL)
			}
			if errors.Is(err, ErrUnknownContext) {
				t.Error("errors.Is(json-gold error, ErrUnknownContext) = true; json-gold now unwraps and this guard's premise no longer holds")
			}
		})
	}
}

func TestCanonicalize_UnknownContextIsErrUnknownContext(t *testing.T) {
	loader := unknownContextLoader()
	for _, d := range unknownContextDocuments() {
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
}

// The loader with no extra contexts is the one most callers hold; the
// sentinel must survive for it too, not only for a loader built by the test.
func TestCanonicalize_UnknownContextIsErrUnknownContextUnderTheVendoredLoader(t *testing.T) {
	out, err := Canonicalize(map[string]any{"@context": unknownContextURL, "a": "b"}, NewDocumentLoader(nil))
	if out != "" {
		t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
	}
	wantUnknownContext(t, err)
}

// HashDocument canonicalizes the document and the proof options separately;
// an unknown context in either must keep its sentinel through the extra layer
// of wrapping.
func TestHashDocument_UnknownContextIsErrUnknownContext(t *testing.T) {
	loader := unknownContextLoader()
	proof := ProofOptions{
		Type:               CryptosuiteEd25519Signature2020,
		Created:            "2026-04-01T00:00:00Z",
		VerificationMethod: "did:web:example.com#key-1",
		ProofPurpose:       "assertionMethod",
	}
	for _, c := range []struct {
		name string
		doc  map[string]any
		opts HashOptions
	}{
		{
			name: "in the document's own context",
			doc:  map[string]any{"@context": unknownContextURL, "a": "b"},
			opts: HashOptions{Cryptosuite: CryptosuiteEd25519Signature2020, ProofOptions: proof},
		},
		{
			name: "in the injected default context",
			doc:  map[string]any{"a": "b"},
			opts: HashOptions{Cryptosuite: CryptosuiteEd25519Signature2020, ProofOptions: proof, DefaultDocContext: []any{unknownContextURL}},
		},
		{
			name: "in a nested node reached through a registered context",
			doc:  parseJSONDocument(t, `{"@context":"`+termScopedContextURL+`","wrapper":{"a":"b"}}`),
			opts: HashOptions{Cryptosuite: CryptosuiteSecp256k1Recovery2020, ProofOptions: ProofOptions{
				Type:               CryptosuiteSecp256k1Recovery2020,
				Created:            proof.Created,
				VerificationMethod: proof.VerificationMethod,
				ProofPurpose:       proof.ProofPurpose,
			}},
		},
		{
			name: "in the proof options' context",
			doc: map[string]any{
				"@context": W3CVCV1ContextURL,
				"type":     "VerifiableCredential",
				"issuer":   "did:web:example.com",
			},
			opts: HashOptions{Cryptosuite: CryptosuiteEd25519Signature2020, ProofOptions: ProofOptions{
				Type:               proof.Type,
				Created:            proof.Created,
				VerificationMethod: proof.VerificationMethod,
				ProofPurpose:       proof.ProofPurpose,
				Context:            []any{unknownContextURL},
			}},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			res, panicked, err := hashDocumentRecovering(c.doc, c.opts, loader)
			if panicked != nil {
				t.Fatalf("HashDocument panicked with %v, want an error matching ErrUnknownContext", panicked)
			}
			if !reflect.DeepEqual(res, HashResult{}) {
				t.Errorf("HashDocument result = %+v alongside an error, want the zero HashResult", res)
			}
			wantUnknownContext(t, err)
		})
	}
}

// The admission check runs before json-gold loads any context, so a document
// both naming an unknown context and breaking an admission rule is refused by
// the rule. Reporting the rule is what lets the caller fix the document; and
// refusing before loading anything keeps an inadmissible document from
// driving the loader at all.
func TestCanonicalize_AdmissionRefusalTakesPrecedenceOverAnUnknownContext(t *testing.T) {
	loader := unknownContextLoader()
	for _, c := range []struct {
		name     string
		json     string
		wantRule AdmissionRule
		wantPath string
	}{
		{"a reserved key", `{"@context":"` + unknownContextURL + `","@id":"urn:x","a":"b"}`, RuleReservedKey, "/@id"},
		{"an inline context beside an unknown URL", `{"@context":["` + unknownContextURL + `",{"a":"https://registered.example/vocab#a"}],"a":"b"}`, RuleContextShape, "/@context"},
		{"a blank-node label", `{"@context":"` + unknownContextURL + `","a":"_:b0"}`, RuleBlankNodeLabel, "/a"},
		{"a compact IRI key", `{"@context":"` + unknownContextURL + `","ex:a":"b"}`, RuleCompactIRIKey, "/ex:a"},
	} {
		t.Run(c.name, func(t *testing.T) {
			out, panicked, err := canonicalizeRecovering(parseJSONDocument(t, c.json), loader)
			if panicked != nil {
				t.Fatalf("Canonicalize panicked with %v", panicked)
			}
			if out != "" {
				t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
			}
			var ae *AdmissionError
			if !errors.As(err, &ae) {
				t.Fatalf("err = %v, want *AdmissionError", err)
			}
			if ae.Rule != c.wantRule || ae.Path != c.wantPath {
				t.Errorf("AdmissionError = {Rule: %q, Path: %q}, want {Rule: %q, Path: %q}", ae.Rule, ae.Path, c.wantRule, c.wantPath)
			}
			if errors.Is(err, ErrUnknownContext) {
				t.Errorf("errors.Is(err, ErrUnknownContext) = true for %v, want false: the refusal precedes any context load", err)
			}
		})
	}
}

// Restoring the sentinel must not reclassify the failures that have their own
// class: a json-gold panic stays ErrCanonicalizationFailed, and a json-gold
// error unrelated to loading stays unclassified.
func TestCanonicalize_OtherFailuresAreNotErrUnknownContext(t *testing.T) {
	loader := unknownContextLoader()
	for _, d := range panickingDocuments() {
		t.Run("panic/"+d.name, func(t *testing.T) {
			_, panicked, err := canonicalizeRecovering(parseJSONDocument(t, d.json), loader)
			if panicked != nil {
				t.Fatalf("Canonicalize panicked with %v", panicked)
			}
			wantCanonicalizationFailed(t, err)
			if errors.Is(err, ErrUnknownContext) {
				t.Errorf("errors.Is(err, ErrUnknownContext) = true for %v, want false", err)
			}
		})
	}
	t.Run("a context whose body is not an object", func(t *testing.T) {
		const url = "https://registered.example/not-an-object.jsonld"
		l := loader.WithExtraContexts(map[string]any{url: "not an object"})
		_, err := Canonicalize(map[string]any{"@context": url, "a": "b"}, l)
		if err == nil {
			t.Fatal("err = nil, want json-gold's invalid-remote-context error")
		}
		if errors.Is(err, ErrUnknownContext) {
			t.Errorf("errors.Is(err, ErrUnknownContext) = true for %v, want false: the context was found", err)
		}
		if errors.Is(err, ErrNotCanonicalizable) || errors.Is(err, ErrCanonicalizationFailed) {
			t.Errorf("err = %v classified as an admission or canonicalization failure, want neither", err)
		}
	})
}

// A registered context must canonicalize exactly as before: the literal is
// the URDNA2015 output for this document under the vendored W3C VC v1 twin.
func TestCanonicalize_RegisteredContextOutputIsUnchanged(t *testing.T) {
	const want = "_:c14n0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://www.w3.org/2018/credentials#VerifiableCredential> .\n" +
		"_:c14n0 <https://www.w3.org/2018/credentials#issuer> <did:web:example.com> .\n"
	for _, l := range []struct {
		name   string
		loader *DocumentLoader
	}{
		{"vendored contexts", NewDocumentLoader(nil)},
		{"with the contexts that reach an unknown one", unknownContextLoader()},
	} {
		t.Run(l.name, func(t *testing.T) {
			doc := map[string]any{
				"@context": []any{W3CVCV1ContextURL},
				"type":     "VerifiableCredential",
				"issuer":   "did:web:example.com",
			}
			ref, err := referenceNormalize(copyJSON(t, doc), l.loader)
			if err != nil {
				t.Fatalf("referenceNormalize: %v", err)
			}
			if ref != want {
				t.Fatalf("json-gold output differs from the pinned literal\n--- got ---\n%s\n--- want ---\n%s", ref, want)
			}
			got, err := Canonicalize(doc, l.loader)
			if err != nil {
				t.Fatalf("Canonicalize: %v", err)
			}
			if got != want {
				t.Errorf("Canonicalize output differs\n--- got ---\n%s\n--- want ---\n%s", got, want)
			}
		})
	}
}
