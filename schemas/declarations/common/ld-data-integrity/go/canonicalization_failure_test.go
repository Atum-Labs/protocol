package lddataintegrity

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/piprate/json-gold/ld"
)

// canonicalizationFailureMarkers are distinctive literals planted in the
// documents below. None may appear in a returned error: a document is
// caller-supplied and may carry personal or payment data, and the error text
// reaches logs and HTTP responses.
var canonicalizationFailureMarkers = []string{
	"canary-issuer-5e1f07",
	"urn:canary-subject-9b24d3",
	"739157",
}

type panickingDocument struct {
	name string
	json string
}

// panickingDocuments pass every admission rule yet make json-gold v0.5.0 panic
// ("assignment to entry in nil map") while converting them to RDF: a number or
// a boolean, bare or in an array, where the context declares a graph
// container. A string, an empty string, null, an empty array and an empty
// object in the same position do not panic; see
// nonPanickingGraphContainerDocuments.
func panickingDocuments() []panickingDocument {
	const prefix = `{"@context":"https://www.w3.org/2018/credentials/v1","id":"urn:canary-subject-9b24d3","type":"VerifiableCredential","issuer":"did:web:canary-issuer-5e1f07.example",`
	return []panickingDocument{
		{"an integer-valued number in the proof graph container", prefix + `"proof":739157}`},
		{"zero in the proof graph container", prefix + `"proof":0}`},
		{"a negative fraction in the proof graph container", prefix + `"proof":-1.5}`},
		{"true in the proof graph container", prefix + `"proof":true}`},
		{"false in the proof graph container", prefix + `"proof":false}`},
		{"an array holding a number in the proof graph container", prefix + `"proof":[739157]}`},
		{"an array holding a boolean in the proof graph container", prefix + `"proof":[true]}`},
		{"a number in the verifiableCredential graph container", prefix + `"verifiableCredential":739157}`},
		{"a number in a nested node's proof graph container", prefix + `"credentialSubject":{"id":"urn:canary-subject-9b24d3:inner","proof":739157}}`},
	}
}

func parseJSONDocument(t *testing.T, s string) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal([]byte(s), &doc); err != nil {
		t.Fatalf("parse test document: %v", err)
	}
	return doc
}

// canonicalizeRecovering runs Canonicalize and reports a panic as a value, so
// a panic that escapes it fails the one test rather than the whole binary.
func canonicalizeRecovering(doc any, loader *DocumentLoader) (out string, panicked any, err error) {
	defer func() { panicked = recover() }()
	out, err = Canonicalize(doc, loader)
	return out, nil, err
}

func hashDocumentRecovering(doc map[string]any, opts HashOptions, loader *DocumentLoader) (res HashResult, panicked any, err error) {
	defer func() { panicked = recover() }()
	res, err = HashDocument(doc, opts, loader)
	return res, nil, err
}

// wantCanonicalizationFailed checks the whole contract for a document
// json-gold cannot process: a sentinel of its own, distinct from an
// admission refusal, with none of the document's content in the text.
func wantCanonicalizationFailed(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("err = nil, want an error matching ErrCanonicalizationFailed")
	}
	if !errors.Is(err, ErrCanonicalizationFailed) {
		t.Errorf("errors.Is(err, ErrCanonicalizationFailed) = false for %v", err)
	}
	// The document satisfies every admission rule; calling it a refusal
	// would send callers looking for a rule and path that do not exist.
	if errors.Is(err, ErrNotCanonicalizable) {
		t.Errorf("errors.Is(err, ErrNotCanonicalizable) = true for %v, want false", err)
	}
	var ae *AdmissionError
	if errors.As(err, &ae) {
		t.Errorf("errors.As(err, *AdmissionError) = true ({Rule: %q, Path: %q}), want false", ae.Rule, ae.Path)
	}
	for _, m := range canonicalizationFailureMarkers {
		if strings.Contains(err.Error(), m) {
			t.Errorf("err = %q contains document content %q", err, m)
		}
	}
}

// Guards the premise: each document really does panic inside bare json-gold.
// Should an upgrade stop the panic, this fails and the tests below no longer
// prove that Canonicalize contains one.
func TestJSONGold_ToRDFPanicsOnAScalarInAGraphContainer(t *testing.T) {
	loader := NewDocumentLoader(nil)
	for _, d := range panickingDocuments() {
		t.Run(d.name, func(t *testing.T) {
			doc := parseJSONDocument(t, d.json)
			if err := CheckCanonicalizable(copyJSON(t, doc)); err != nil {
				t.Fatalf("CheckCanonicalizable = %v, want admission: the document must reach json-gold", err)
			}
			panicked := func() (r any) {
				defer func() { r = recover() }()
				_, _ = ld.NewJsonLdProcessor().ToRDF(copyJSON(t, doc), jsonGoldOptions(loader))
				return nil
			}()
			if panicked == nil {
				t.Fatal("json-gold ToRDF returned without panicking; the premise of the containment tests no longer holds")
			}
			if !strings.Contains(fmt.Sprint(panicked), "assignment to entry in nil map") {
				t.Errorf("json-gold panicked with %v, want the nil-map assignment these documents are known to trigger", panicked)
			}
		})
	}
}

func TestErrCanonicalizationFailed_IsItsOwnSentinel(t *testing.T) {
	if ErrCanonicalizationFailed == nil {
		t.Fatal("ErrCanonicalizationFailed is nil")
	}
	if ErrCanonicalizationFailed.Error() == "" {
		t.Error("ErrCanonicalizationFailed has an empty message")
	}
	for _, other := range []error{ErrNotCanonicalizable, ErrUnknownContext, ErrMalformedProof} {
		if errors.Is(ErrCanonicalizationFailed, other) || errors.Is(other, ErrCanonicalizationFailed) {
			t.Errorf("ErrCanonicalizationFailed and %v match each other, want distinct sentinels", other)
		}
	}
}

// A panic inside json-gold must not escape Canonicalize: in a server it
// becomes a 500 at best and a crashed process at worst, for a document that
// is merely unprocessable.
func TestCanonicalize_JSONGoldPanicIsReturnedAsErrCanonicalizationFailed(t *testing.T) {
	loaders := []struct {
		name   string
		loader *DocumentLoader
	}{
		{"vendored contexts", NewDocumentLoader(nil)},
		{"with PaymentRequest context", datasetLoader(t, loadDatasetVectors(t))},
	}
	for _, l := range loaders {
		for _, d := range panickingDocuments() {
			t.Run(l.name+"/"+d.name, func(t *testing.T) {
				out, panicked, err := canonicalizeRecovering(parseJSONDocument(t, d.json), l.loader)
				if panicked != nil {
					t.Fatalf("Canonicalize panicked with %v, want an error matching ErrCanonicalizationFailed", panicked)
				}
				if out != "" {
					t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
				}
				wantCanonicalizationFailed(t, err)
			})
		}
	}
}

// Recovering must leave the loader usable: a later, well-formed document on
// the same loader still canonicalizes exactly as json-gold alone would.
func TestCanonicalize_LoaderStillWorksAfterAContainedPanic(t *testing.T) {
	loader := NewDocumentLoader(nil)
	good := map[string]any{
		"@context": W3CVCV1ContextURL,
		"id":       "urn:after",
		"type":     "VerifiableCredential",
		"issuer":   "did:web:example.com",
	}
	want, err := referenceNormalize(copyJSON(t, good), loader)
	if err != nil {
		t.Fatalf("referenceNormalize: %v", err)
	}
	for _, d := range panickingDocuments() {
		if _, panicked, _ := canonicalizeRecovering(parseJSONDocument(t, d.json), loader); panicked != nil {
			t.Fatalf("%s: Canonicalize panicked with %v", d.name, panicked)
		}
	}
	got, panicked, err := canonicalizeRecovering(copyJSON(t, good), loader)
	if panicked != nil {
		t.Fatalf("Canonicalize panicked with %v on a well-formed document", panicked)
	}
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	if got != want {
		t.Errorf("output after contained panics differs from json-gold's\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

// The values that sit beside the panicking ones in the same graph container
// but do not panic must keep canonicalizing exactly as json-gold alone does.
func TestCanonicalize_NonPanickingValuesInAGraphContainerAreUnaffected(t *testing.T) {
	loader := NewDocumentLoader(nil)
	const prefix = `{"@context":"https://www.w3.org/2018/credentials/v1","id":"urn:x","type":"VerifiableCredential","proof":`
	for _, c := range []struct{ name, value string }{
		{"a string", `"text"`},
		{"an empty string", `""`},
		{"null", `null`},
		{"an empty array", `[]`},
		{"an array holding a string", `["text"]`},
		{"an empty object", `{}`},
	} {
		t.Run(c.name, func(t *testing.T) {
			doc := parseJSONDocument(t, prefix+c.value+`}`)
			want, err := referenceNormalize(copyJSON(t, doc), loader)
			if err != nil {
				t.Fatalf("referenceNormalize: %v", err)
			}
			got, panicked, err := canonicalizeRecovering(copyJSON(t, doc), loader)
			if panicked != nil {
				t.Fatalf("Canonicalize panicked with %v", panicked)
			}
			if err != nil {
				t.Fatalf("Canonicalize: %v, want admission", err)
			}
			if got != want {
				t.Errorf("output differs from json-gold's\n--- got ---\n%s\n--- want ---\n%s", got, want)
			}
		})
	}
}

// HashDocument strips the top-level proof, so only a graph container it keeps
// reaches json-gold: the nested one, and verifiableCredential when not
// stripped.
func TestHashDocument_JSONGoldPanicIsReturnedAsErrCanonicalizationFailed(t *testing.T) {
	loader := NewDocumentLoader(nil)
	opts := HashOptions{
		Cryptosuite: CryptosuiteEd25519Signature2020,
		ProofOptions: ProofOptions{
			Type:               CryptosuiteEd25519Signature2020,
			Created:            "2026-04-01T00:00:00Z",
			VerificationMethod: "did:web:example.com#key-1",
			ProofPurpose:       "assertionMethod",
		},
	}
	for _, name := range []string{
		"a number in the verifiableCredential graph container",
		"a number in a nested node's proof graph container",
	} {
		t.Run(name, func(t *testing.T) {
			var src string
			for _, d := range panickingDocuments() {
				if d.name == name {
					src = d.json
				}
			}
			if src == "" {
				t.Fatalf("no panicking document named %q", name)
			}
			res, panicked, err := hashDocumentRecovering(parseJSONDocument(t, src), opts, loader)
			if panicked != nil {
				t.Fatalf("HashDocument panicked with %v, want an error matching ErrCanonicalizationFailed", panicked)
			}
			if !reflect.DeepEqual(res, HashResult{}) {
				t.Errorf("HashDocument result = %+v alongside an error, want the zero HashResult", res)
			}
			wantCanonicalizationFailed(t, err)
		})
	}
}
