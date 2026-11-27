package ldverification

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
	"github.com/piprate/json-gold/ld"
)

// datasetQuote is a FulfillmentQuote whose two destination entries carry the
// given accounts. With equal accounts the entries expand to two blank nodes
// with the same first-degree quads; with different accounts they are
// distinct. The shared vectors cannot be used here, as fqLoader does not
// resolve the PaymentRequest context they are written in.
func datasetQuote(a, b string) map[string]any {
	return map[string]any{
		"@context":       []any{fulfillmentQuoteContextURL, secp256k1Recovery2020V2CtxURL},
		"version":        "1.0",
		"source_amount":  "1000000",
		"award_deadline": "2030-01-01T00:00:00Z",
		"destination": []any{
			map[string]any{"account": a},
			map[string]any{"account": b},
		},
		"settler_address": "0x1234567890123456789012345678901234567890",
	}
}

func datasetHashOptions() HashQuoteOptions {
	return HashQuoteOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeSecp256k1Recovery2020,
			Created:            "2026-04-01T00:00:00.000Z",
			VerificationMethod: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266#blockchainAccountId",
			ProofPurpose:       "assertionMethod",
		},
	}
}

// HashQuote is the path signing and verification both take, so a quote with
// indistinguishable blank nodes must be refused there, and classified as
// caller-supplied malformed input while keeping the library's verdict
// reachable. The distinct counterpart hashes under the same options, so the
// refusal cannot come from the options.
func TestHashQuote_RefusesIndistinguishableBlankNodes(t *testing.T) {
	if _, err := HashQuote(datasetQuote("0x01", "0x02"), datasetHashOptions()); err != nil {
		t.Fatalf("control: HashQuote with distinct destination entries = %v, want success", err)
	}

	res, err := HashQuote(datasetQuote("0x01", "0x01"), datasetHashOptions())
	if err == nil {
		t.Fatalf("HashQuote returned signing input %x and a nil error; want refusal", res.SigningInput)
	}
	if !errors.Is(err, ErrMalformedQuote) {
		t.Errorf("errors.Is(err, ErrMalformedQuote) = false for %v", err)
	}
	if !errors.Is(err, lddataintegrity.ErrNotCanonicalizable) {
		t.Errorf("errors.Is(err, lddataintegrity.ErrNotCanonicalizable) = false for %v", err)
	}
	var ae *lddataintegrity.AdmissionError
	if !errors.As(err, &ae) {
		t.Fatalf("errors.As(err, *lddataintegrity.AdmissionError) = false for %T %v", err, err)
	}
	if ae.Rule != lddataintegrity.RuleIndistinguishableBlankNodes || ae.Path != "" {
		t.Errorf("AdmissionError = {Rule: %q, Path: %q}, want {Rule: %q, Path: \"\"}", ae.Rule, ae.Path, lddataintegrity.RuleIndistinguishableBlankNodes)
	}
}

// referenceNormalize is json-gold's own one-call URDNA2015 normalization
// under the same loader: what every admitted document must still
// canonicalize to, byte for byte, so the admission rules cannot move a
// signing input.
func referenceNormalize(doc any, loader *lddataintegrity.DocumentLoader) (string, error) {
	opts := ld.NewJsonLdOptions("")
	opts.DocumentLoader = loader
	opts.Algorithm = ld.AlgorithmURDNA2015
	opts.Format = "application/n-quads"
	out, err := ld.NewJsonLdProcessor().Normalize(doc, opts)
	if err != nil {
		return "", err
	}
	s, ok := out.(string)
	if !ok {
		return "", fmt.Errorf("Normalize returned %T, want string", out)
	}
	return s, nil
}

func copyJSON(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

// Byte identity over every JSON-LD document in the example, conformance tree
// and Go bindings' testdata of the two declarations fqLoader serves
// (FulfillmentQuote and FulfillmentQuoteEnvelope), through both the library
// entry point and this binding's wrapper. Where json-gold cannot process a
// document under fqLoader, both must fail as well.
func TestCanonicalize_FulfillmentQuoteCorpusMatchesJSONGoldNormalize(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("cwd: %v", err)
	}
	declarations := filepath.Join(cwd, "..", "..", "..", "..", "..")
	compared := 0
	for _, dir := range []string{"FulfillmentQuote", "FulfillmentQuoteEnvelope"} {
		root, err := filepath.Abs(filepath.Join(declarations, dir, "v1"))
		if err != nil {
			t.Fatalf("abs: %v", err)
		}
		for _, d := range jsonLDDocumentsUnder(t, root) {
			name := dir + "/v1/" + d.name
			want, wantErr := referenceNormalize(copyJSON(t, d.doc), fqLoader)
			lib, libErr := lddataintegrity.Canonicalize(copyJSON(t, d.doc), fqLoader)
			wrapped, wrappedErr := Canonicalize(copyJSON(t, d.doc))
			if wantErr != nil {
				if libErr == nil || wrappedErr == nil {
					t.Errorf("%s: json-gold fails (%v) but lddataintegrity.Canonicalize err = %v, Canonicalize err = %v; want both to fail", name, wantErr, libErr, wrappedErr)
				}
				continue
			}
			compared++
			if libErr != nil || wrappedErr != nil {
				t.Errorf("%s: lddataintegrity.Canonicalize err = %v, Canonicalize err = %v; want both to admit", name, libErr, wrappedErr)
				continue
			}
			if lib != want {
				t.Errorf("%s: lddataintegrity.Canonicalize output differs from json-gold Normalize\n--- Canonicalize ---\n%s\n--- Normalize ---\n%s", name, lib, want)
			}
			if wrapped != want {
				t.Errorf("%s: Canonicalize output differs from json-gold Normalize\n--- Canonicalize ---\n%s\n--- Normalize ---\n%s", name, wrapped, want)
			}
		}
	}
	// fqLoader resolves the twelve signed, credential and presentation
	// fixtures in the conformance tree, and the envelope example; the
	// pre-presentation fixtures name the PaymentRequestEnvelope context,
	// which only a per-call overlay registers.
	if compared < 13 {
		t.Fatalf("compared %d documents against json-gold, want at least 13", compared)
	}
}

type jsonLDDocument struct {
	name string
	doc  map[string]any
}

// jsonLDDocumentsUnder returns each outermost object carrying "@context" in
// a declaration version directory's example.json, conformance tree, and Go
// bindings' testdata.
func jsonLDDocumentsUnder(t *testing.T, root string) []jsonLDDocument {
	t.Helper()
	var docs []jsonLDDocument
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".json" {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		switch {
		case len(parts) == 1 && parts[0] == "example.json":
		case parts[0] == "conformance":
		case len(parts) > 2 && parts[0] == "bindings" && parts[1] == "go" && containsPart(parts[2:len(parts)-1], "testdata"):
		default:
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
		eachJSONLDDocument(v, "", func(ptr string, doc map[string]any) {
			docs = append(docs, jsonLDDocument{name: rel + "#" + ptr, doc: doc})
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	return docs
}

func containsPart(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// eachJSONLDDocument does not descend into a document it reports, so an
// embedded credential is canonicalized as part of its carrier, as it would be
// in production.
func eachJSONLDDocument(v any, ptr string, fn func(string, map[string]any)) {
	switch x := v.(type) {
	case map[string]any:
		if _, ok := x["@context"]; ok {
			fn(ptr, x)
			return
		}
		for k, c := range x {
			esc := strings.ReplaceAll(strings.ReplaceAll(k, "~", "~0"), "/", "~1")
			eachJSONLDDocument(c, ptr+"/"+esc, fn)
		}
	case []any:
		for i, c := range x {
			eachJSONLDDocument(c, fmt.Sprintf("%s/%d", ptr, i), fn)
		}
	}
}
