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

type sharedDatasetVectors struct {
	Accept []sharedAdmissionVector `json:"accept"`
	Refuse []sharedAdmissionVector `json:"refuse"`
}

// loadSharedDatasetVectors reads the dataset section of the library's
// language-neutral admission vectors. Its documents use the PaymentRequest
// context, which prLoader registers, or the vendored credentials context.
func loadSharedDatasetVectors(t *testing.T) sharedDatasetVectors {
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
		Dataset sharedDatasetVectors `json:"dataset"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if len(f.Dataset.Refuse) == 0 || len(f.Dataset.Accept) != len(f.Dataset.Refuse) {
		t.Fatalf("%s: %d dataset refuse, %d dataset accept; want a non-empty refuse list with one accept counterpart each", path, len(f.Dataset.Refuse), len(f.Dataset.Accept))
	}
	return f.Dataset
}

func datasetHashOptions() HashPaymentRequestOptions {
	return HashPaymentRequestOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeSecp256k1Recovery2020,
			Created:            fixtureCreated,
			VerificationMethod: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266#blockchainAccountId",
			ProofPurpose:       expectedProofPurpose,
		},
	}
}

// HashPaymentRequest is the path signing and verification both take, so a
// document the library refuses for its dataset, whether for
// indistinguishable blank nodes or for an estimated output over the budget,
// must be refused there under the same rule, and classified as
// caller-supplied malformed input while keeping the library's verdict
// reachable. Each refused document's counterpart hashes under the same
// options, so a refusal cannot come from the options.
func TestHashPaymentRequest_RefusesTheSharedDatasetVectors(t *testing.T) {
	vectors := loadSharedDatasetVectors(t)
	vectorRules := map[string]bool{
		string(lddataintegrity.RuleIndistinguishableBlankNodes): true,
		string(lddataintegrity.RuleOutputBudget):                true,
	}
	for i, v := range vectors.Refuse {
		t.Run(v.Name, func(t *testing.T) {
			if v.Rule == nil || !vectorRules[*v.Rule] {
				t.Fatalf("vector rule %v, want %q or %q", v.Rule, lddataintegrity.RuleIndistinguishableBlankNodes, lddataintegrity.RuleOutputBudget)
			}
			rule := lddataintegrity.AdmissionRule(*v.Rule)
			counterpart := vectors.Accept[i]
			if _, err := HashPaymentRequest(counterpart.Doc.(map[string]any), datasetHashOptions()); err != nil {
				t.Fatalf("control %q: HashPaymentRequest = %v, want success", counterpart.Name, err)
			}

			res, err := HashPaymentRequest(v.Doc.(map[string]any), datasetHashOptions())
			if err == nil {
				t.Fatalf("HashPaymentRequest returned signing input %x and a nil error; want refusal", res.SigningInput)
			}
			if !errors.Is(err, ErrMalformedRequest) {
				t.Errorf("errors.Is(err, ErrMalformedRequest) = false for %v", err)
			}
			if !errors.Is(err, lddataintegrity.ErrNotCanonicalizable) {
				t.Errorf("errors.Is(err, lddataintegrity.ErrNotCanonicalizable) = false for %v", err)
			}
			var ae *lddataintegrity.AdmissionError
			if !errors.As(err, &ae) {
				t.Fatalf("errors.As(err, *lddataintegrity.AdmissionError) = false for %T %v", err, err)
			}
			if ae.Rule != rule || ae.Path != "" {
				t.Errorf("AdmissionError = {Rule: %q, Path: %q}, want {Rule: %q, Path: \"\"}", ae.Rule, ae.Path, rule)
			}
		})
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

// Byte identity over every JSON-LD document in PaymentRequest/v1's example,
// conformance tree and Go bindings' testdata, under this binding's loader,
// through both the library entry point and this binding's wrapper. Where
// json-gold cannot process a document, both must fail as well.
func TestCanonicalize_PaymentRequestCorpusMatchesJSONGoldNormalize(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("cwd: %v", err)
	}
	root, err := filepath.Abs(filepath.Join(cwd, "..", "..", ".."))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	compared := 0
	for _, d := range jsonLDDocumentsUnder(t, root) {
		want, wantErr := referenceNormalize(copyJSON(t, d.doc), prLoader)
		lib, libErr := lddataintegrity.Canonicalize(copyJSON(t, d.doc), prLoader)
		wrapped, wrappedErr := Canonicalize(copyJSON(t, d.doc))
		if wantErr != nil {
			if libErr == nil || wrappedErr == nil {
				t.Errorf("%s: json-gold fails (%v) but lddataintegrity.Canonicalize err = %v, Canonicalize err = %v; want both to fail", d.name, wantErr, libErr, wrappedErr)
			}
			continue
		}
		compared++
		if libErr != nil || wrappedErr != nil {
			t.Errorf("%s: lddataintegrity.Canonicalize err = %v, Canonicalize err = %v; want both to admit", d.name, libErr, wrappedErr)
			continue
		}
		if lib != want {
			t.Errorf("%s: lddataintegrity.Canonicalize output differs from json-gold Normalize\n--- Canonicalize ---\n%s\n--- Normalize ---\n%s", d.name, lib, want)
		}
		if wrapped != want {
			t.Errorf("%s: Canonicalize output differs from json-gold Normalize\n--- Canonicalize ---\n%s\n--- Normalize ---\n%s", d.name, wrapped, want)
		}
	}
	// The four signed conformance fixtures resolve under prLoader.
	if compared < 4 {
		t.Fatalf("compared %d documents under %s against json-gold, want at least 4", compared, root)
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
