package lddataintegrity

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// goldenInlineLimit is the length in UTF-8 bytes up to which the vector file
// carries an expected output verbatim; a longer one is carried as its SHA-256
// and length. Restated from the file's comment rather than derived from the
// file, so the guard checks the file against the contract.
const goldenInlineLimit = 4096

var goldenSHA256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// goldenSection is one list of accept vectors that may carry an expected
// output, with requireGolden set where the file's comment requires one.
type goldenSection struct {
	name          string
	vectors       []admissionVector
	requireGolden bool
}

// goldenSections splits the accept vectors by the section of the file they
// come from. loadAdmissionVectors appends the expanded generated vectors to
// Accept, so the literal ones are its prefix.
func goldenSections(t *testing.T) []goldenSection {
	t.Helper()
	f := loadAdmissionVectors(t)
	literal := f.Accept[:len(f.Accept)-len(f.Generated.Accept)]
	generated := make([]admissionVector, len(f.Generated.Accept))
	for i, g := range f.Generated.Accept {
		generated[i] = g.admissionVector
	}
	return []goldenSection{
		{"accept", literal, false},
		{"generated.accept", generated, false},
		{"dataset.accept", loadDatasetVectors(t).Dataset.Accept, true},
	}
}

func hasGolden(v admissionVector) bool {
	return v.Nquads != nil || v.NquadsSHA256 != nil || v.NquadsLength != nil
}

// wantGolden compares an output with the vector's expected output, verbatim
// or by digest and length.
func wantGolden(t *testing.T, got string, v admissionVector) {
	t.Helper()
	if v.Nquads != nil {
		if got != *v.Nquads {
			t.Errorf("output differs from the shared expected output\n--- got (%d bytes) ---\n%s\n--- expected (%d bytes) ---\n%s", len(got), got, len(*v.Nquads), *v.Nquads)
		}
		return
	}
	sum := sha256.Sum256([]byte(got))
	if hex.EncodeToString(sum[:]) != *v.NquadsSHA256 || len(got) != *v.NquadsLength {
		t.Errorf("output of %d bytes with SHA-256 %x, want the shared expected output of %d bytes with SHA-256 %s", len(got), sum, *v.NquadsLength, *v.NquadsSHA256)
	}
}

// Guards the expected outputs themselves: each is in exactly one of the two
// forms, the form its length calls for; every dataset accept vector carries
// one; and every other accept vector carries one or a known-divergence reason
// exactly when json-gold canonicalizes it under the richer of the two
// loaders. A vector that stopped carrying its expected output, or a refuse
// vector that started carrying one, would otherwise drop out of the
// cross-language comparison unnoticed.
func TestAdmissionVectors_ExpectedOutputsFollowTheFileFormat(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	carried, divergent := 0, 0
	for _, s := range goldenSections(t) {
		for _, v := range s.vectors {
			t.Run(s.name+"/"+v.Name, func(t *testing.T) {
				switch {
				case v.Nquads != nil:
					if v.NquadsSHA256 != nil || v.NquadsLength != nil {
						t.Errorf("carries nquads and nquads_sha256/nquads_length; want one form")
					}
					if n := len(*v.Nquads); n > goldenInlineLimit {
						t.Errorf("nquads is %d bytes, over the %d-byte inline limit; want nquads_sha256 and nquads_length", n, goldenInlineLimit)
					}
				case v.NquadsSHA256 != nil || v.NquadsLength != nil:
					if v.NquadsSHA256 == nil || v.NquadsLength == nil {
						t.Fatalf("nquads_sha256 %v and nquads_length %v; want both", v.NquadsSHA256, v.NquadsLength)
					}
					if !goldenSHA256Pattern.MatchString(*v.NquadsSHA256) {
						t.Errorf("nquads_sha256 %q is not 64 lowercase hex digits", *v.NquadsSHA256)
					}
					if *v.NquadsLength <= goldenInlineLimit {
						t.Errorf("nquads_length %d is within the %d-byte inline limit; want nquads", *v.NquadsLength, goldenInlineLimit)
					}
				}
				if v.KnownDivergence != nil {
					if hasGolden(v) {
						t.Errorf("carries both an expected output and known_divergence")
					}
					if r := *v.KnownDivergence; strings.TrimSpace(r) == "" || strings.Contains(r, "\n") {
						t.Errorf("known_divergence %q, want a one-line reason", r)
					}
				}
				if s.requireGolden {
					if !hasGolden(v) {
						t.Errorf("dataset accept vector carries no expected output")
					}
					if v.KnownDivergence != nil {
						t.Errorf("dataset accept vector carries known_divergence")
					}
				} else if pin, ok := knownDivergences[v.Name]; ok && pin.refused && v.KnownDivergence != nil {
					// The other implementation canonicalizes it, so it is
					// marked although json-gold cannot process it.
					if _, err := referenceNormalize(copyJSON(t, v.Doc), loader); !errors.Is(err, errJSONGoldPanicked) {
						t.Errorf("json-gold's side is pinned as a refusal, so json-gold must panic on it; referenceNormalize = %v", err)
					}
				} else {
					_, err := referenceNormalize(copyJSON(t, v.Doc), loader)
					marked := hasGolden(v) || v.KnownDivergence != nil
					if err == nil && !marked {
						t.Errorf("canonicalizes but carries neither an expected output nor known_divergence")
					}
					if err != nil && marked {
						t.Errorf("carries an expected output or known_divergence but does not canonicalize: %v", err)
					}
				}
				if hasGolden(v) {
					carried++
				}
				if v.KnownDivergence != nil {
					divergent++
				}
			})
		}
	}
	// An emptied or unparsed set of expected outputs would pass the loop
	// above vacuously.
	if carried == 0 {
		t.Error("no accept vector carries an expected output")
	}
	t.Logf("%d vectors carry an expected output, %d a known divergence", carried, divergent)

	f := loadAdmissionVectors(t)
	df := loadDatasetVectors(t)
	for _, list := range [][]admissionVector{f.Refuse, df.Dataset.Refuse} {
		for _, v := range list {
			if hasGolden(v) || v.KnownDivergence != nil {
				t.Errorf("refuse vector %q carries an expected output or known_divergence", v.Name)
			}
		}
	}
}

// The expected outputs are what every implementation must produce, so a
// byte of difference between the languages fails in at least one of them.
// Each vector is compared under every loader that resolves its contexts;
// the richer loader must resolve all of them. A vector with a known
// divergence has no expected output, but must still be admitted.
func TestCanonicalize_AcceptVectorsMatchTheSharedExpectedOutput(t *testing.T) {
	loaders := []struct {
		name   string
		loader *DocumentLoader
	}{
		{"vendored", NewDocumentLoader(nil)},
		{"with PaymentRequest context", datasetLoader(t, loadDatasetVectors(t))},
	}
	vectors, compared := 0, 0
	for _, s := range goldenSections(t) {
		for _, v := range s.vectors {
			if v.KnownDivergence != nil {
				if pin, ok := knownDivergences[v.Name]; ok && pin.refused {
					t.Run(s.name+"/"+v.Name+"/not refused by admission despite its known divergence, but failed by json-gold", func(t *testing.T) {
						out, err := Canonicalize(copyJSON(t, v.Doc), loaders[1].loader)
						if out != "" {
							t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
						}
						wantCanonicalizationFailed(t, err)
					})
					continue
				}
				t.Run(s.name+"/"+v.Name+"/admitted despite its known divergence", func(t *testing.T) {
					if _, err := Canonicalize(copyJSON(t, v.Doc), loaders[1].loader); err != nil {
						t.Errorf("Canonicalize = %v, want admission", err)
					}
				})
				continue
			}
			if !hasGolden(v) {
				continue
			}
			vectors++
			for i, l := range loaders {
				t.Run(s.name+"/"+l.name+"/"+v.Name, func(t *testing.T) {
					if _, err := referenceNormalize(copyJSON(t, v.Doc), l.loader); err != nil {
						if i == len(loaders)-1 {
							t.Fatalf("json-gold cannot canonicalize a vector carrying an expected output: %v", err)
						}
						return
					}
					compared++
					got, err := Canonicalize(copyJSON(t, v.Doc), l.loader)
					if err != nil {
						t.Fatalf("Canonicalize = %v, want the shared expected output", err)
					}
					wantGolden(t, got, v)
				})
			}
		}
	}
	if vectors == 0 || compared < vectors {
		t.Errorf("compared %d outputs over %d vectors carrying an expected output, want at least one per vector", compared, vectors)
	}
}

// knownDivergence is json-gold's own side of a divergence the vector file
// declares. That side is either canonical output, pinned by its length and
// SHA-256 and by the lines whose presence (contains) or absence (lacks) makes
// it differ from the other implementations', or, where refused is set, no
// output at all: json-gold cannot process the document, and Canonicalize
// returns ErrCanonicalizationFailed where the other implementations return
// N-Quads.
type knownDivergence struct {
	refused  bool
	length   int
	sha256   string
	contains []string
	lacks    []string
	// datasetContextsOnly marks a vector naming a context only the file's
	// dataset.contexts supplies, so under the vendored loader alone it must
	// fail as an unknown context instead of canonicalizing.
	datasetContextsOnly bool
}

// httpsIRIOfLength is the credential id the IRI-length vectors use: an https
// IRI of exactly n code points.
func httpsIRIOfLength(n int) string {
	const prefix = "https://e.x/"
	return prefix + strings.Repeat("a", n-len(prefix))
}

// The canonical outputs several classes share: the credential's type
// statement alone, and that statement beside a proof statement pointing at
// an empty proof graph.
const (
	divergentTypeOnlyLength    = 119
	divergentTypeOnlySHA256    = "9cd1c6821d482f5047b0438a2658dea5c1c27b89b252a9415496064e59c6d1fe"
	divergentHollowProofLength = 171
	divergentHollowProofSHA256 = "b74d3f0ca55d947d2c7c85c01afe1063d93a9c18d33eeb26b1a1ec8e83c315a4"
	divergentEmptyOutputSHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	divergentHollowProofQuad   = "<urn:x> <https://w3id.org/security#proof> _:c14n"
	divergentIssuerPredicate   = "<https://www.w3.org/2018/credentials#issuer>"
)

// hollowProofDivergence is json-gold's side of every vector whose proof graph
// container holds nothing jsonld.js turns into a statement: json-gold keeps
// the proof statement pointing at the empty graph.
var hollowProofDivergence = knownDivergence{
	length:   divergentHollowProofLength,
	sha256:   divergentHollowProofSHA256,
	contains: []string{divergentHollowProofQuad},
}

// urlParseDivergence is json-gold's side of every vector whose issuer IRI its
// IRI check rejects: json-gold drops the issuer statement, leaving the type
// statement alone.
var urlParseDivergence = knownDivergence{
	length: divergentTypeOnlyLength,
	sha256: divergentTypeOnlySHA256,
	lacks:  []string{divergentIssuerPredicate},
}

// scalarInGraphDivergence is json-gold's side of a number or boolean in a
// graph container: json-gold panics on it, so Canonicalize refuses it.
var scalarInGraphDivergence = knownDivergence{refused: true}

// knownDivergences restates the vectors the file's comment names as known to
// canonicalize differently, rather than deriving the list from the markers,
// so a marker added to or dropped from any other vector fails. Pinning this
// side's output is what makes the marker fail once the implementations
// agree, instead of skipping the comparison for good.
var knownDivergences = map[string]knownDivergence{
	"verifiable presentation embedding one credential as an array element": {
		length: 904,
		sha256: "f6782ee007b85a6a6e9442732db46be4adcef8fb43ac55f9869e22719b2bd750",
		// json-gold keeps the undefined proof type terms as relative-IRI
		// rdf:type objects; jsonld.js drops both quads.
		contains: []string{
			"<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <Ed25519Signature2020> ",
			"<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <EcdsaSecp256k1RecoverySignature2020> ",
		},
	},

	"hollow graph container: an empty proof object":                                   hollowProofDivergence,
	"hollow graph container: a proof holding only a term the context does not define": hollowProofDivergence,
	"hollow graph container: a proof holding only an id":                              hollowProofDivergence,
	"hollow graph container: a proof that is an IRI string":                           hollowProofDivergence,
	// The inner empty proof adds a second empty graph and a proof statement
	// inside the outer one, both of which jsonld.js drops with the outer.
	"hollow graph container: a proof holding only an empty proof": {
		length:   231,
		sha256:   "cf305eb653097de79febf633e12fd4939894be3244077a9ec669bc414be54eb2",
		contains: []string{divergentHollowProofQuad, "<https://w3id.org/security#proof> _:c14n0 _:c14n2 ."},
	},

	// jsonld.js drops the statement as an invalid IRI and emits nothing.
	"IRI with a space: a credential id holding U+0020": {
		length:   121,
		sha256:   "a5153041669f40ff4585e933d508691c7d2a1141032de29c71ead0a87c6c01e5",
		contains: []string{"<urn:a b> "},
	},

	// json-gold writes the IRI's backslash and double quote escaped with a
	// backslash; rdf-canonize writes them as they are.
	"IRI escaping: a credential id holding a backslash": {
		length:   122,
		sha256:   "2ea7fe6737b81182b8b06cf0a1dc30711aa8976639d9c365741eeaf552b5b7fc",
		contains: []string{`<urn:a\\b> `},
		lacks:    []string{`<urn:a\b> `},
	},
	"IRI escaping: a credential id holding a double quote": {
		length:   122,
		sha256:   "8ad639d92ab405fea43ad385a95567eb985a4657f3df69ae65333c5f170aac43",
		contains: []string{`<urn:a\"b> `},
		lacks:    []string{`<urn:a"b> `},
	},

	// json-gold drops the whole node, so its output is empty.
	"http(s) IRI json-gold rejects: a credential id with an invalid percent-escape (https://e.x/a%zz)": {
		sha256: divergentEmptyOutputSHA256,
		lacks:  []string{"<https://e.x/a%zz> "},
	},
	"http(s) IRI json-gold rejects: a credential id with an empty host (https:///a)": {
		sha256: divergentEmptyOutputSHA256,
		lacks:  []string{"<https:///a> "},
	},
	"http(s) IRI json-gold rejects: a credential id of 2083 code points": {
		sha256: divergentEmptyOutputSHA256,
		lacks:  []string{"<" + httpsIRIOfLength(2083) + "> "},
	},

	"url.Parse class: an issuer IRI with an invalid percent-escape in a non-http scheme (foo:/a%zz)": urlParseDivergence,
	"url.Parse class: an issuer IRI holding U+0001":                                                  urlParseDivergence,
	"url.Parse class: an issuer IRI with a non-numeric port (foo://a:b/)":                            urlParseDivergence,

	"string in a graph container: a proof that is a plain string": hollowProofDivergence,

	"scalar in a graph container: a proof that is the number 5": scalarInGraphDivergence,
	"scalar in a graph container: a proof that is true":         scalarInGraphDivergence,

	// The shape an Ed25519 settler's presentation takes around a
	// secp256k1-signed credential. json-gold keeps the credential's undefined
	// proof type as a relative-IRI rdf:type object; jsonld.js drops it.
	"mixed-suite envelope: an Ed25519Signature2020 presentation under the FulfillmentQuoteEnvelope context embedding a credential whose proof type EcdsaSecp256k1RecoverySignature2020 no loaded context defines": {
		length:              2740,
		sha256:              "2999ed651621bfbf7a892def5d9b5d539b98737df3ac84b6a5b28ac502c3d142",
		contains:            []string{"<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <EcdsaSecp256k1RecoverySignature2020> "},
		datasetContextsOnly: true,
	},
}

// Guards the pins themselves: a refusal pins no output, and an output pin
// carries a well-formed digest, so neither form can be left half filled and
// pass vacuously.
func TestAdmissionVectors_KnownDivergencePinsAreWellFormed(t *testing.T) {
	refused := 0
	for name, pin := range knownDivergences {
		if pin.refused {
			refused++
			if pin.length != 0 || pin.sha256 != "" || len(pin.contains) != 0 || len(pin.lacks) != 0 {
				t.Errorf("%q: pinned as a refusal but also pins output %+v", name, pin)
			}
			continue
		}
		if !goldenSHA256Pattern.MatchString(pin.sha256) {
			t.Errorf("%q: sha256 %q is not 64 lowercase hex digits", name, pin.sha256)
		}
		if len(pin.contains) == 0 && len(pin.lacks) == 0 {
			t.Errorf("%q: pins no line that makes json-gold's output differ", name)
		}
	}
	if refused == 0 {
		t.Error("no known divergence is pinned as a refusal; the scalar-in-graph-container class has gone missing")
	}
}

func TestAdmissionVectors_KnownDivergencesAreExactlyTheNamedOnes(t *testing.T) {
	var marked []string
	for _, s := range goldenSections(t) {
		for _, v := range s.vectors {
			if v.KnownDivergence != nil {
				marked = append(marked, v.Name)
			}
		}
	}
	for _, v := range loadAdmissionVectors(t).Refuse {
		if v.KnownDivergence != nil {
			marked = append(marked, v.Name)
		}
	}
	var want []string
	for name := range knownDivergences {
		want = append(want, name)
	}
	sort.Strings(marked)
	sort.Strings(want)
	if !reflect.DeepEqual(marked, want) {
		t.Errorf("vectors carrying known_divergence = %q, want exactly %q", marked, want)
	}

	raw, err := os.ReadFile(admissionVectorsPath(t))
	if err != nil {
		t.Fatalf("read admission vectors: %v", err)
	}
	var file struct {
		Comment string `json:"_comment"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("parse admission vectors: %v", err)
	}
	for _, name := range want {
		if !strings.Contains(file.Comment, "'"+name+"'") {
			t.Errorf("_comment does not name known-divergent vector %q", name)
		}
	}
}

// json-gold's side of each declared divergence, under every loader that
// resolves the vector's contexts. It fails the day json-gold's output
// changes, including the day it starts agreeing with jsonld.js, which is
// when the marker must give way to a shared expected output.
func TestCanonicalize_KnownDivergentVectorsKeepJSONGoldsSideOfTheDifference(t *testing.T) {
	loaders := []struct {
		name     string
		loader   *DocumentLoader
		vendored bool
	}{
		{"vendored", NewDocumentLoader(nil), true},
		{"with PaymentRequest context", datasetLoader(t, loadDatasetVectors(t)), false},
	}
	found := 0
	for _, v := range loadAdmissionVectors(t).Accept {
		pin, ok := knownDivergences[v.Name]
		if !ok {
			continue
		}
		found++
		for _, l := range loaders {
			t.Run(l.name+"/"+v.Name, func(t *testing.T) {
				got, err := Canonicalize(copyJSON(t, v.Doc), l.loader)
				if pin.datasetContextsOnly && l.vendored {
					// json-gold's own context loading fails on it too, and
					// that failure is not an admission refusal.
					if _, refErr := referenceNormalize(copyJSON(t, v.Doc), l.loader); refErr == nil || errors.Is(refErr, errJSONGoldPanicked) {
						t.Errorf("referenceNormalize = %v under the vendored loader, want json-gold to fail loading the context only dataset.contexts supplies", refErr)
					}
					if err == nil {
						t.Fatalf("Canonicalize returned %d bytes under the vendored loader, want failure: the vector names a context only dataset.contexts supplies", len(got))
					}
					if errors.Is(err, ErrNotCanonicalizable) {
						t.Errorf("Canonicalize = %v, an admission refusal; want the context-loading failure", err)
					}
					if got != "" {
						t.Errorf("Canonicalize output = %q alongside an error, want empty", got)
					}
					return
				}
				if pin.refused {
					if got != "" {
						t.Errorf("Canonicalize output = %q alongside an error, want empty", got)
					}
					wantCanonicalizationFailed(t, err)
					return
				}
				if err != nil {
					t.Fatalf("Canonicalize = %v, want admission", err)
				}
				for _, line := range pin.contains {
					if !strings.Contains(got, line) {
						t.Errorf("output lacks %q, the quad that makes json-gold's output differ\n%s", line, got)
					}
				}
				for _, line := range pin.lacks {
					if strings.Contains(got, line) {
						t.Errorf("output holds %q, whose absence makes json-gold's output differ\n%s", line, got)
					}
				}
				sum := sha256.Sum256([]byte(got))
				if len(got) != pin.length || hex.EncodeToString(sum[:]) != pin.sha256 {
					t.Errorf("output of %d bytes with SHA-256 %x, want json-gold's pinned %d bytes with SHA-256 %s\n%s", len(got), sum, pin.length, pin.sha256, got)
				}
			})
		}
	}
	if found != len(knownDivergences) {
		t.Errorf("found %d of the %d known-divergent vectors among the accept vectors", found, len(knownDivergences))
	}
}
