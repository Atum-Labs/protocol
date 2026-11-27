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
// document may carry quote data, so none may surface in an error.
var canonicalizationFailureMarkers = []string{"urn:canary-quote-2d9e61", "739157"}

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
		t.Fatal("err = nil, want ErrMalformedQuote and lddataintegrity.ErrCanonicalizationFailed")
	}
	if !errors.Is(err, ErrMalformedQuote) {
		t.Errorf("errors.Is(err, ErrMalformedQuote) = false for %v", err)
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

// The FulfillmentQuote context declares proof a graph container, and json-gold
// panics on a number there instead of returning an error.
func TestCanonicalize_JSONGoldPanicIsErrMalformedQuoteAndErrCanonicalizationFailed(t *testing.T) {
	doc := parseCanonicalizationFailureDoc(t, `{"@context":["`+fulfillmentQuoteContextURL+`"],"id":"urn:canary-quote-2d9e61","type":"FulfillmentQuote","proof":739157}`)
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

// HashQuote strips the top-level proof, so the graph container that
// reaches json-gold is one inside a nested node.
func TestHashQuote_JSONGoldPanicIsErrMalformedQuoteAndErrCanonicalizationFailed(t *testing.T) {
	const body = `"id":"urn:canary-quote-2d9e61","type":"FulfillmentQuote","source":{"id":"urn:canary-quote-2d9e61:source","proof":739157}`
	for _, c := range []struct{ name, json string }{
		{"explicit @context", `{"@context":["` + fulfillmentQuoteContextURL + `"],` + body + `}`},
		{"default @context", `{` + body + `}`},
	} {
		t.Run(c.name, func(t *testing.T) {
			doc := parseCanonicalizationFailureDoc(t, c.json)
			res, panicked, err := func() (res HashResult, panicked any, err error) {
				defer func() { panicked = recover() }()
				res, err = HashQuote(doc, datasetHashOptions())
				return res, nil, err
			}()
			if panicked != nil {
				t.Fatalf("HashQuote panicked with %v, want an error", panicked)
			}
			if !reflect.DeepEqual(res, HashResult{}) {
				t.Errorf("HashQuote result = %+v alongside an error, want the zero HashResult", res)
			}
			wantMalformedAndCanonicalizationFailed(t, err)
		})
	}
}
