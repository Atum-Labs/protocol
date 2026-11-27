package ldverification

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

type sharedAdmissionVector struct {
	Name string  `json:"name"`
	Rule *string `json:"rule"`
	Path *string `json:"path"`
	Doc  any     `json:"doc"`
}

// loadSharedAdmissionVector reads a refuse vector from the library's
// language-neutral admission vectors, so this wrapper is exercised with the
// exact bytes the library itself is tested against.
func loadSharedAdmissionVector(t *testing.T, prefix string) sharedAdmissionVector {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("cwd: %v", err)
	}
	path := filepath.Join(cwd, "..", "..", "..", "..", "..", "common", "ld-data-integrity", "conformance", "admission-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var f struct {
		Refuse []sharedAdmissionVector `json:"refuse"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	for _, v := range f.Refuse {
		if strings.HasPrefix(v.Name, prefix) {
			return v
		}
	}
	t.Fatalf("no refuse vector named %q... in %s", prefix, path)
	return sharedAdmissionVector{}
}

// A document refused by admission is caller-supplied malformed input, so it
// must classify under this binding's ErrMalformedQuote umbrella like every other
// malformed-shape failure, while keeping the library's sentinel in the chain
// for callers that want to tell admission refusals apart.
func TestCanonicalize_AdmissionRefusalIsErrMalformedQuoteAndErrNotCanonicalizable(t *testing.T) {
	out, err := Canonicalize(loadSharedAdmissionVector(t, "clique:").Doc)
	if err == nil {
		t.Fatalf("Canonicalize returned %d bytes of N-Quads and a nil error; want refusal", len(out))
	}
	if !errors.Is(err, ErrMalformedQuote) {
		t.Errorf("errors.Is(err, ErrMalformedQuote) = false for %v", err)
	}
	if !errors.Is(err, lddataintegrity.ErrNotCanonicalizable) {
		t.Errorf("errors.Is(err, lddataintegrity.ErrNotCanonicalizable) = false for %v", err)
	}
}

// The wrapper adds its own classification on top of the library's error, so
// the library's *AdmissionError must still be reachable through every layer
// of wrapping with its rule and location intact; otherwise a caller could
// learn that a document was refused but not why or where. A single-rule,
// single-location vector is used so the expected rule and path are exact.
func TestCanonicalize_AdmissionRefusalExposesTheLibraryAdmissionError(t *testing.T) {
	v := loadSharedAdmissionVector(t, "reserved key @type at the root")
	if v.Rule == nil || v.Path == nil || *v.Rule != "reserved-key" || *v.Path != "/@type" {
		t.Fatalf("vector %q: rule %v path %v, want exactly reserved-key at /@type", v.Name, v.Rule, v.Path)
	}
	out, err := Canonicalize(v.Doc)
	if err == nil {
		t.Fatalf("Canonicalize returned %d bytes of N-Quads and a nil error; want refusal", len(out))
	}
	if !errors.Is(err, ErrMalformedQuote) {
		t.Errorf("errors.Is(err, ErrMalformedQuote) = false for %v", err)
	}
	var ae *lddataintegrity.AdmissionError
	if !errors.As(err, &ae) {
		t.Fatalf("errors.As(err, *lddataintegrity.AdmissionError) = false for %T %v", err, err)
	}
	if ae.Rule != lddataintegrity.RuleReservedKey || ae.Path != "/@type" {
		t.Errorf("AdmissionError = {Rule: %q, Path: %q}, want {Rule: %q, Path: %q}", ae.Rule, ae.Path, lddataintegrity.RuleReservedKey, "/@type")
	}
}
