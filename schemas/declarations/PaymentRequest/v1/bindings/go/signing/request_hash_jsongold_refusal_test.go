package ldverification

import (
	"encoding/json"
	"errors"
	"testing"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
	"github.com/piprate/json-gold/ld"
)

// The top-level @context is replaced before hashing, so a document reaches
// json-gold with a context of its own choosing only through a nested object.
// The credentials context protects terms the PaymentRequest context already
// defines, so loading it on a nested node asks json-gold to redefine a
// protected term, which it refuses with an error rather than a panic. The
// mutated object is open in the JSON Schema, so a gateway hands such a request
// to ComputeRequestHash, and the refusal must classify as malformed input
// rather than surface as a server fault.
func TestComputeRequestHash_JSONGoldErrorIsErrMalformedRequest(t *testing.T) {
	// The unmutated request hashes, so the nested context is the only cause
	// of the failure below.
	if _, err := ComputeRequestHash(mustMarshalRequest(t, baseRequest())); err != nil {
		t.Fatalf("ComputeRequestHash on the unmutated request: %v", err)
	}

	d := baseRequest()
	d["source"].(map[string]any)["@context"] = lddataintegrity.W3CVCV1ContextURL

	h, panicked, err := func() (h string, panicked any, err error) {
		defer func() { panicked = recover() }()
		h, err = ComputeRequestHash(mustMarshalRequest(t, d))
		return h, nil, err
	}()
	if panicked != nil {
		t.Fatalf("ComputeRequestHash panicked with %v, want an error", panicked)
	}
	if h != "" {
		t.Errorf("ComputeRequestHash = %q alongside an error, want empty", h)
	}
	if err == nil {
		t.Fatal("err = nil, want an error matching ErrMalformedRequest")
	}
	if !errors.Is(err, ErrMalformedRequest) {
		t.Errorf("errors.Is(err, ErrMalformedRequest) = false for %v", err)
	}
	// The library's classification stays in the chain beneath this binding's
	// umbrella, as it does for a contained panic.
	if !errors.Is(err, lddataintegrity.ErrCanonicalizationFailed) {
		t.Errorf("errors.Is(err, lddataintegrity.ErrCanonicalizationFailed) = false for %v", err)
	}
	if errors.Is(err, lddataintegrity.ErrUnknownContext) {
		t.Errorf("errors.Is(err, lddataintegrity.ErrUnknownContext) = true for %v, want false: the context is registered", err)
	}
	if errors.Is(err, lddataintegrity.ErrNotCanonicalizable) {
		t.Errorf("errors.Is(err, lddataintegrity.ErrNotCanonicalizable) = true for %v, want false: the request is admitted", err)
	}
	var jerr *ld.JsonLdError
	if !errors.As(err, &jerr) {
		t.Fatalf("errors.As(err, *ld.JsonLdError) = false for %v, want json-gold's error kept in the chain", err)
	}
	if jerr.Code != ld.ProtectedTermRedefinition {
		t.Errorf("chained json-gold error code = %q, want %q", jerr.Code, ld.ProtectedTermRedefinition)
	}
}

func mustMarshalRequest(t *testing.T, m map[string]any) []byte {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}
