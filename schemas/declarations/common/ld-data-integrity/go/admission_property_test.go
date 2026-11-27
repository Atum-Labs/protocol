package lddataintegrity

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"sort"
	"sync"
	"testing"
	"time"
)

// The literal pools are deliberately tiny, so that two generated nodes often
// carry the same literals and differ, if at all, only in their surroundings.
// That is what makes indistinguishable blank nodes common enough for the
// dataset rule to be exercised from both sides.
var (
	propertyAccounts   = []string{"0x01", "0x02", "0x03"}
	propertyAssets     = []string{"eip155:1/erc20:0x01", "eip155:1/erc20:0x02"}
	propertyRequestIDs = []string{"req-1", "req-2"}
)

// Generator bounds used by the fixed-seed property test. They keep most
// documents far inside the JSON budgets, so nearly every run reaches the
// dataset rules.
const (
	propertyMaxDepth  = 3
	propertyMaxFanout = 3
)

// Fuzzed generator parameters are reduced modulo one more than these, so
// every fuzzed depth and fanout lands in [0, max] and a fuzzed document stays
// within a few levels and a few entries per array.
const (
	fuzzMaxDepth  = 4
	fuzzMaxFanout = 4
)

// generatePropertyDocument builds a PaymentRequest-context document from a
// seed, using only terms the context defines: "source" nests one object,
// "destination" holds an array of objects, "proof" is a graph container, and
// "account", "asset_identifier" and "request_id" are string-typed literals.
// The document's depth is drawn from [1, maxDepth] (0 when maxDepth is 0) and each destination
// array's length from [0, maxFanout], so small and large shapes both occur.
// The same arguments always yield the same document.
func generatePropertyDocument(seed uint64, maxDepth, maxFanout int) map[string]any {
	r := rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
	depth := 0
	if maxDepth > 0 {
		depth = 1 + r.IntN(maxDepth)
	}
	root := generatePropertyNode(r, depth, maxFanout)
	root["@context"] = datasetPaymentRequestContextURL
	if r.IntN(2) == 0 {
		root["request_id"] = propertyRequestIDs[r.IntN(len(propertyRequestIDs))]
	}
	return root
}

func generatePropertyNode(r *rand.Rand, depth, maxFanout int) map[string]any {
	n := map[string]any{}
	if r.IntN(3) != 0 {
		n["account"] = propertyAccounts[r.IntN(len(propertyAccounts))]
	}
	if r.IntN(3) == 0 {
		n["asset_identifier"] = propertyAssets[r.IntN(len(propertyAssets))]
	}
	if depth == 0 {
		return n
	}
	if r.IntN(3) == 0 {
		n["source"] = generatePropertyNode(r, depth-1, maxFanout)
	}
	if r.IntN(2) == 0 {
		dest := make([]any, r.IntN(maxFanout+1))
		for i := range dest {
			dest[i] = generatePropertyNode(r, depth-1, maxFanout)
		}
		n["destination"] = dest
	}
	if r.IntN(4) == 0 {
		n["proof"] = generatePropertyNode(r, depth-1, maxFanout)
	}
	return n
}

// propertyOutcome is what one generated document did, for the distribution
// guard.
type propertyOutcome struct {
	// rule is the refusing rule, or "" when the document was admitted.
	rule AdmissionRule
	// blankNodes is the measured blank-node count, or -1 when the JSON
	// pre-check refused the document and it was never expanded.
	blankNodes int
}

func isDeclaredAdmissionRule(r AdmissionRule) bool {
	for _, d := range allAdmissionRules {
		if r == d {
			return true
		}
	}
	for _, d := range codeOnlyAdmissionRules {
		if r == d {
			return true
		}
	}
	for _, d := range datasetAdmissionRules {
		if r == d {
			return true
		}
	}
	return false
}

// checkGeneratedDocumentProperties runs Canonicalize on a copy of doc and
// checks it against the test's own reading of the dataset:
//
//   - P1: every error is an *AdmissionError with a declared rule, returned
//     with empty output. Every term the generator uses is defined, so no
//     JSON-LD processing error is legitimate here.
//   - P2: an admitted document has no two blank nodes sharing first-degree
//     quads, so URDNA2015 never reaches Hash N-Degree Quads, the step whose
//     cost is super-polynomial.
//   - P3: an admitted document canonicalizes to exactly what json-gold's own
//     Normalize produces.
//   - P4: a document that passes the JSON pre-check, fits the blank-node
//     and output budgets and has indistinguishable blank nodes is refused
//     for exactly that reason.
//   - P5: a document that passes the JSON pre-check, fits the blank-node
//     and output budgets and has no indistinguishable blank nodes is not
//     refused at all.
//
// Together P4 and P5 make the dataset rule an iff within the budgets:
// Canonicalize refuses for indistinguishable blank nodes exactly when the
// test's own first-degree grouping finds a duplicate. P4 alone would let a
// rule that over-refuses pass, and P5 alone one that under-refuses.
func checkGeneratedDocumentProperties(t *testing.T, doc map[string]any, loader *DocumentLoader) propertyOutcome {
	t.Helper()
	jsonErr := CheckCanonicalizable(copyJSON(t, doc))
	out := propertyOutcome{blankNodes: -1}
	var shape datasetShape
	estimate := 0
	if jsonErr == nil {
		shape = measureDataset(t, doc, loader)
		out.blankNodes = shape.blankNodes
		estimate = measureOutputEstimate(t, doc, loader)
	}

	got, err := Canonicalize(copyJSON(t, doc), loader)
	if err != nil {
		if got != "" {
			t.Errorf("Canonicalize output is %d bytes alongside an error, want empty", len(got))
		}
		if !errors.Is(err, ErrNotCanonicalizable) {
			t.Errorf("errors.Is(err, ErrNotCanonicalizable) = false for %T %v", err, err)
		}
		var ae *AdmissionError
		if !errors.As(err, &ae) {
			t.Fatalf("Canonicalize err = %T %v, want *AdmissionError", err, err)
		}
		if !isDeclaredAdmissionRule(ae.Rule) {
			t.Fatalf("AdmissionError rule %q is not a declared AdmissionRule", ae.Rule)
		}
		out.rule = ae.Rule
		withinBudgets := jsonErr == nil && shape.blankNodes <= datasetBlankNodeBudget && estimate <= datasetOutputBudget
		if withinBudgets && len(shape.duplicates) > 0 && ae.Rule != RuleIndistinguishableBlankNodes {
			t.Errorf("P4: document with indistinguishable blank nodes %v refused as {%q %q}, want %q", shape.duplicates, ae.Rule, ae.Path, RuleIndistinguishableBlankNodes)
		}
		if withinBudgets && len(shape.duplicates) == 0 {
			t.Errorf("P5: document within the budgets with no indistinguishable blank nodes (%d blank nodes, %d quads) refused as {%q %q}, want admission; document: %v", shape.blankNodes, shape.quads, ae.Rule, ae.Path, copyJSON(t, doc))
		}
		return out
	}

	if jsonErr != nil {
		t.Fatalf("Canonicalize admitted a document CheckCanonicalizable refuses (%v)", jsonErr)
	}
	if len(shape.duplicates) > 0 {
		t.Fatalf("P2/P4: Canonicalize admitted a document with indistinguishable blank nodes: %v", shape.duplicates)
	}
	if estimate > datasetOutputBudget {
		t.Fatalf("Canonicalize admitted a document estimated at %d bytes of output, over the budget of %d", estimate, datasetOutputBudget)
	}
	want, err := referenceNormalize(copyJSON(t, doc), loader)
	if err != nil {
		t.Fatalf("reference Normalize: %v", err)
	}
	if got != want {
		t.Fatalf("P3: Canonicalize output differs from json-gold Normalize\n--- Canonicalize ---\n%s\n--- Normalize ---\n%s", got, want)
	}
	return out
}

const propertySeedCount = 2000

// Every generated document is either refused with a declared rule or
// admitted with no indistinguishable blank nodes and json-gold's own bytes,
// and within the budgets a document is refused for indistinguishable blank
// nodes if and only if it has them. A failure names its seed;
// generatePropertyDocument(seed, 3, 3) rebuilds the document.
func TestCanonicalize_GeneratedDocumentsProperty(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	start := time.Now()
	byRule := map[AdmissionRule]int{}
	ran, admitted, admittedNonTrivial := 0, 0, 0
	for seed := uint64(0); seed < propertySeedCount; seed++ {
		doc := generatePropertyDocument(seed, propertyMaxDepth, propertyMaxFanout)
		var o propertyOutcome
		// A subtest excluded by -run reports success without running, and
		// its zero outcome would otherwise be tallied as an admission.
		didRun := false
		ok := t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			didRun = true
			o = checkGeneratedDocumentProperties(t, doc, loader)
		})
		if !ok {
			t.Fatalf("seed %d failed; document: %v", seed, copyJSON(t, doc))
		}
		if !didRun {
			continue
		}
		ran++
		if o.rule == "" {
			admitted++
			// Two or more blank nodes is where P2 says something: a lone
			// blank node cannot collide with anything.
			if o.blankNodes >= 2 {
				admittedNonTrivial++
			}
		} else {
			byRule[o.rule]++
		}
	}
	elapsed := time.Since(start)

	rules := make([]string, 0, len(byRule))
	for r, n := range byRule {
		rules = append(rules, fmt.Sprintf("%s=%d", r, n))
	}
	sort.Strings(rules)
	t.Logf("%d documents in %v: %d admitted (%d with at least two blank nodes), refused %v", ran, elapsed, admitted, admittedNonTrivial, rules)

	// The floors below are fractions of the full seed range, so they mean
	// nothing for a filtered rerun of a few seeds.
	if ran != propertySeedCount {
		t.Logf("%d of %d seeds ran; distribution guard not enforced", ran, propertySeedCount)
		return
	}

	// The distribution guard: without both outcomes the properties above
	// would hold vacuously, so a generator that drifts into admitting or
	// refusing everything must fail here. The floors are loose fractions of
	// the run, well under the shares the generator produces.
	if admittedNonTrivial < propertySeedCount/20 {
		t.Errorf("%d documents admitted with at least two blank nodes, want at least %d", admittedNonTrivial, propertySeedCount/20)
	}
	if n := byRule[RuleIndistinguishableBlankNodes]; n < propertySeedCount/20 {
		t.Errorf("%d documents refused for %s, want at least %d", n, RuleIndistinguishableBlankNodes, propertySeedCount/20)
	}
}

// fuzzDocument maps the fuzz target's raw arguments onto a generated
// document, so the seed-corpus check below builds exactly what the target
// does.
func fuzzDocument(seed uint64, depth, fanout uint8) map[string]any {
	d := int(depth) % (fuzzMaxDepth + 1)
	k := int(fanout) % (fuzzMaxFanout + 1)
	return generatePropertyDocument(seed, d, k)
}

type fuzzSeed struct {
	seed          uint64
	depth, fanout uint8
	// refused is true when the generated document is refused for
	// indistinguishable blank nodes, and false when it is admitted.
	refused bool
}

// fuzzSeedCorpus holds both outcomes, so that replaying the seed corpus
// under plain go test reaches the refusal branch and P4/P5 as well as the
// admission branch. The refused entries come from the property test's seed
// range at its own depth and fanout.
var fuzzSeedCorpus = []fuzzSeed{
	{seed: 0, depth: propertyMaxDepth, fanout: propertyMaxFanout},
	{seed: 1, depth: 1, fanout: 2},
	{seed: 7, depth: 2, fanout: 4},
	{seed: 42, depth: 4, fanout: 3},
	{seed: 1 << 63, depth: 3, fanout: 1},
	{seed: 0xdeadbeef, depth: 0, fanout: 0},
	{seed: 5, depth: propertyMaxDepth, fanout: propertyMaxFanout, refused: true},
	{seed: 16, depth: propertyMaxDepth, fanout: propertyMaxFanout, refused: true},
	{seed: 29, depth: propertyMaxDepth, fanout: propertyMaxFanout, refused: true},
}

// Each seed-corpus entry has the outcome it is listed with, and both
// outcomes are present, so a generator change that turns every seed into an
// admission cannot quietly take the refusal branch out of the replay.
func TestFuzzCanonicalize_SeedCorpusCoversBothOutcomes(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	admitted, refused := 0, 0
	for _, s := range fuzzSeedCorpus {
		_, err := Canonicalize(copyJSON(t, fuzzDocument(s.seed, s.depth, s.fanout)), loader)
		if s.refused {
			refused++
			var ae *AdmissionError
			if !errors.As(err, &ae) || ae.Rule != RuleIndistinguishableBlankNodes {
				t.Errorf("seed %+v: Canonicalize err = %v, want refusal for %s", s, err, RuleIndistinguishableBlankNodes)
			}
			continue
		}
		admitted++
		if err != nil {
			t.Errorf("seed %+v: Canonicalize err = %v, want admission", s, err)
		}
	}
	if admitted == 0 || refused == 0 {
		t.Errorf("seed corpus lists %d admitted and %d refused entries, want both non-zero", admitted, refused)
	}
}

// The same properties for one fuzzed document. The arguments are the
// generator's own parameters rather than raw JSON, so every input is a
// well-formed document over the context's terms and the fuzzer spends its
// time on shapes, not on inputs the JSON decoder or pre-check rejects.
func FuzzCanonicalize_GeneratedDocuments(f *testing.F) {
	for _, s := range fuzzSeedCorpus {
		f.Add(s.seed, s.depth, s.fanout)
	}

	// The loader is built from the vector file on first use: the helper
	// reports through a *testing.T, which only the fuzz target receives.
	var (
		once   sync.Once
		loader *DocumentLoader
	)
	f.Fuzz(func(t *testing.T, seed uint64, depth, fanout uint8) {
		once.Do(func() { loader = datasetLoader(t, loadDatasetVectors(t)) })
		if loader == nil {
			t.Fatal("dataset loader was not built")
		}
		checkGeneratedDocumentProperties(t, fuzzDocument(seed, depth, fanout), loader)
	})
}
