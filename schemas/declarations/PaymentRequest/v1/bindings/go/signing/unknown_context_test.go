package ldverification

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// unknownContextURL is registered by no loader, so every reference to it must
// reach the library's fail-closed branch.
const unknownContextURL = "https://unregistered.example/ctx.jsonld"

// wantMalformedAndUnknownContext: an unregistered context is caller-supplied
// malformed input, so it classifies under this binding's umbrella, while the
// library's sentinel stays in the chain so a caller can tell it from an
// admission refusal, and the URL stays in the text for the operator.
func wantMalformedAndUnknownContext(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("err = nil, want ErrMalformedRequest and lddataintegrity.ErrUnknownContext")
	}
	if !errors.Is(err, ErrMalformedRequest) {
		t.Errorf("errors.Is(err, ErrMalformedRequest) = false for %v", err)
	}
	if !errors.Is(err, lddataintegrity.ErrUnknownContext) {
		t.Errorf("errors.Is(err, lddataintegrity.ErrUnknownContext) = false for %v", err)
	}
	if !strings.Contains(err.Error(), unknownContextURL) {
		t.Errorf("err = %q, want it to name %s", err, unknownContextURL)
	}
	if errors.Is(err, lddataintegrity.ErrNotCanonicalizable) {
		t.Errorf("errors.Is(err, lddataintegrity.ErrNotCanonicalizable) = true for %v, want false", err)
	}
	if errors.Is(err, lddataintegrity.ErrCanonicalizationFailed) {
		t.Errorf("errors.Is(err, lddataintegrity.ErrCanonicalizationFailed) = true for %v, want false", err)
	}
}

func TestCanonicalize_UnknownContextIsErrMalformedRequestAndErrUnknownContext(t *testing.T) {
	for _, c := range []struct{ name, json string }{
		{"a single URL", `{"@context":"` + unknownContextURL + `","a":"b"}`},
		{"a list element after the PaymentRequest context", `{"@context":["` + paymentRequestContextURL + `","` + unknownContextURL + `"],"id":"urn:request","type":"PaymentRequest"}`},
		{"a nested node's own context", `{"@context":["` + paymentRequestContextURL + `"],"id":"urn:request","type":"PaymentRequest","source":{"@context":"` + unknownContextURL + `","id":"urn:request:source"}}`},
	} {
		t.Run(c.name, func(t *testing.T) {
			out, err := Canonicalize(parseCanonicalizationFailureDoc(t, c.json))
			if out != "" {
				t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
			}
			wantMalformedAndUnknownContext(t, err)
		})
	}
}

// HashPaymentRequest canonicalizes through the library directly, not through
// Canonicalize, so it needs the same classification of its own.
func TestHashPaymentRequest_UnknownContextIsErrMalformedRequestAndErrUnknownContext(t *testing.T) {
	withProofContext := datasetHashOptions()
	withProofContext.ProofOptions.Context = []any{unknownContextURL}
	for _, c := range []struct {
		name string
		json string
		opts HashPaymentRequestOptions
	}{
		{"in the document's own context", `{"@context":["` + unknownContextURL + `"],"id":"urn:request","type":"PaymentRequest"}`, datasetHashOptions()},
		{"in a nested node under the default context", `{"id":"urn:request","type":"PaymentRequest","source":{"@context":"` + unknownContextURL + `","id":"urn:request:source"}}`, datasetHashOptions()},
		{"in the proof options' context", `{"id":"urn:request","type":"PaymentRequest"}`, withProofContext},
	} {
		t.Run(c.name, func(t *testing.T) {
			res, err := HashPaymentRequest(parseCanonicalizationFailureDoc(t, c.json), c.opts)
			if !reflect.DeepEqual(res, HashResult{}) {
				t.Errorf("HashPaymentRequest result = %+v alongside an error, want the zero HashResult", res)
			}
			wantMalformedAndUnknownContext(t, err)
		})
	}
}

// The library refuses an inadmissible document before loading any context, so
// naming an unknown one as well must not change the class: it stays an
// admission refusal under this binding's umbrella.
func TestCanonicalize_AdmissionRefusalBeatsAnUnknownContext(t *testing.T) {
	doc := parseCanonicalizationFailureDoc(t, `{"@context":"`+unknownContextURL+`","@id":"urn:request","a":"b"}`)
	for _, c := range []struct {
		name string
		run  func() error
	}{
		{"Canonicalize", func() error { _, err := Canonicalize(doc); return err }},
		{"HashPaymentRequest", func() error { _, err := HashPaymentRequest(doc, datasetHashOptions()); return err }},
	} {
		t.Run(c.name, func(t *testing.T) {
			err := c.run()
			if !errors.Is(err, ErrMalformedRequest) {
				t.Errorf("errors.Is(err, ErrMalformedRequest) = false for %v", err)
			}
			var ae *lddataintegrity.AdmissionError
			if !errors.As(err, &ae) {
				t.Fatalf("err = %v, want a *lddataintegrity.AdmissionError in the chain", err)
			}
			if ae.Rule != lddataintegrity.RuleReservedKey || ae.Path != "/@id" {
				t.Errorf("AdmissionError = {Rule: %q, Path: %q}, want {Rule: %q, Path: %q}", ae.Rule, ae.Path, lddataintegrity.RuleReservedKey, "/@id")
			}
			if errors.Is(err, lddataintegrity.ErrUnknownContext) {
				t.Errorf("errors.Is(err, lddataintegrity.ErrUnknownContext) = true for %v, want false", err)
			}
		})
	}
}
