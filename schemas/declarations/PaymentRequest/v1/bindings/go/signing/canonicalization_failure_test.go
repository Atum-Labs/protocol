package ldverification

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// Distinctive literals planted in the documents below; a caller-supplied
// document may carry payment data, so none may surface in an error.
var canonicalizationFailureMarkers = []string{"urn:canary-request-4c81ae", "739157"}

func parseCanonicalizationFailureDoc(t *testing.T, s string) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal([]byte(s), &doc); err != nil {
		t.Fatalf("parse test document: %v", err)
	}
	return doc
}

// wantMalformedAndCanonicalizationFailed: a document json-gold cannot process
// is caller-supplied malformed input, so it classifies under this binding's
// umbrella, while the library's sentinel stays in the chain to tell it apart
// from an admission refusal.
func wantMalformedAndCanonicalizationFailed(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("err = nil, want ErrMalformedRequest and lddataintegrity.ErrCanonicalizationFailed")
	}
	if !errors.Is(err, ErrMalformedRequest) {
		t.Errorf("errors.Is(err, ErrMalformedRequest) = false for %v", err)
	}
	if !errors.Is(err, lddataintegrity.ErrCanonicalizationFailed) {
		t.Errorf("errors.Is(err, lddataintegrity.ErrCanonicalizationFailed) = false for %v", err)
	}
	if errors.Is(err, lddataintegrity.ErrNotCanonicalizable) {
		t.Errorf("errors.Is(err, lddataintegrity.ErrNotCanonicalizable) = true for %v, want false", err)
	}
	for _, m := range canonicalizationFailureMarkers {
		if strings.Contains(err.Error(), m) {
			t.Errorf("err = %q contains document content %q", err, m)
		}
	}
}

// The PaymentRequest context declares proof a graph container, and json-gold
// panics on a number there instead of returning an error.
func TestCanonicalize_JSONGoldPanicIsErrMalformedRequestAndErrCanonicalizationFailed(t *testing.T) {
	doc := parseCanonicalizationFailureDoc(t, `{"@context":["`+paymentRequestContextURL+`"],"id":"urn:canary-request-4c81ae","type":"PaymentRequest","proof":739157}`)
	out, panicked, err := func() (out string, panicked any, err error) {
		defer func() { panicked = recover() }()
		out, err = Canonicalize(doc)
		return out, nil, err
	}()
	if panicked != nil {
		t.Fatalf("Canonicalize panicked with %v, want an error", panicked)
	}
	if out != "" {
		t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
	}
	wantMalformedAndCanonicalizationFailed(t, err)
}

// HashPaymentRequest strips the top-level proof, so the graph container that
// reaches json-gold is one inside a nested node.
func TestHashPaymentRequest_JSONGoldPanicIsErrMalformedRequestAndErrCanonicalizationFailed(t *testing.T) {
	const body = `"id":"urn:canary-request-4c81ae","type":"PaymentRequest","source":{"id":"urn:canary-request-4c81ae:source","proof":739157}`
	for _, c := range []struct{ name, json string }{
		{"explicit @context", `{"@context":["` + paymentRequestContextURL + `"],` + body + `}`},
		{"default @context", `{` + body + `}`},
	} {
		t.Run(c.name, func(t *testing.T) {
			doc := parseCanonicalizationFailureDoc(t, c.json)
			res, panicked, err := func() (res HashResult, panicked any, err error) {
				defer func() { panicked = recover() }()
				res, err = HashPaymentRequest(doc, datasetHashOptions())
				return res, nil, err
			}()
			if panicked != nil {
				t.Fatalf("HashPaymentRequest panicked with %v, want an error", panicked)
			}
			if !reflect.DeepEqual(res, HashResult{}) {
				t.Errorf("HashPaymentRequest result = %+v alongside an error, want the zero HashResult", res)
			}
			wantMalformedAndCanonicalizationFailed(t, err)
		})
	}
}
