package lddataintegrity

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/piprate/json-gold/ld"
)

// datasetAdmissionRules are the rules Canonicalize applies to the RDF dataset
// a document expands to. They are kept apart from allAdmissionRules because
// CheckCanonicalizable never reports them, and the file guard for the JSON
// rules requires a CheckCanonicalizable refuse vector for every rule it lists.
var datasetAdmissionRules = []AdmissionRule{
	RuleIndistinguishableBlankNodes,
	RuleBlankNodeBudget,
	RuleOutputBudget,
}

// The dataset cap as the contract states it, restated rather than imported
// so the boundary fixtures are checked against the contract and not against
// whatever the implementation happens to use.
const datasetBlankNodeBudget = 1024

const datasetPaymentRequestContextURL = "https://schemas.atum.network/declarations/PaymentRequest/v1/context.jsonld"

type datasetVectorFile struct {
	Dataset struct {
		Contexts map[string]string `json:"contexts"`
		Accept   []admissionVector `json:"accept"`
		Refuse   []admissionVector `json:"refuse"`
	} `json:"dataset"`
}

func loadDatasetVectors(t *testing.T) datasetVectorFile {
	t.Helper()
	raw, err := os.ReadFile(admissionVectorsPath(t))
	if err != nil {
		t.Fatalf("read admission vectors: %v", err)
	}
	var f datasetVectorFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse admission vectors: %v", err)
	}
	if len(f.Dataset.Accept) == 0 || len(f.Dataset.Refuse) == 0 {
		t.Fatalf("admission vectors: %d dataset accept, %d dataset refuse; want both non-empty", len(f.Dataset.Accept), len(f.Dataset.Refuse))
	}
	return f
}

// datasetLoader is the lib's vendored loader plus every context the vector
// file's dataset section names, each read from the path the file gives
// relative to its own directory, so a port resolves the same bytes.
func datasetLoader(t *testing.T, f datasetVectorFile) *DocumentLoader {
	t.Helper()
	if _, ok := f.Dataset.Contexts[datasetPaymentRequestContextURL]; !ok {
		t.Fatalf("dataset.contexts does not name %s", datasetPaymentRequestContextURL)
	}
	dir := filepath.Dir(admissionVectorsPath(t))
	extra := map[string]any{}
	for url, rel := range f.Dataset.Contexts {
		raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatalf("dataset context %s: %v", url, err)
		}
		var ctx any
		if err := json.Unmarshal(raw, &ctx); err != nil {
			t.Fatalf("dataset context %s: %v", url, err)
		}
		extra[url] = ctx
	}
	return NewDocumentLoader(extra)
}

func findDatasetVector(t *testing.T, list []admissionVector, prefix string) admissionVector {
	t.Helper()
	return findAdmissionVector(t, list, prefix)
}

// copyJSON gives each processor its own copy of a document, so neither
// Canonicalize nor the reference normalization can observe the other's
// handling of shared maps.
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

func jsonGoldOptions(loader *DocumentLoader) *ld.JsonLdOptions {
	opts := ld.NewJsonLdOptions("")
	opts.DocumentLoader = loader
	return opts
}

// referenceNormalize is json-gold's own one-call URDNA2015 normalization:
// the output every admitted document must reproduce byte for byte, since the
// admission rules may refuse a document but never change what an admitted
// one canonicalizes to.
//
// A panic inside json-gold is returned as an error wrapping
// errJSONGoldPanicked: some admitted documents make it panic, and one such
// document would otherwise abort the whole test binary instead of failing, or
// being judged by, the one comparison that met it.
func referenceNormalize(doc any, loader *DocumentLoader) (nquads string, err error) {
	defer func() {
		if r := recover(); r != nil {
			nquads, err = "", fmt.Errorf("%w: %v", errJSONGoldPanicked, r)
		}
	}()
	opts := jsonGoldOptions(loader)
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

// errJSONGoldPanicked marks a reference run in which json-gold panicked
// rather than returning.
var errJSONGoldPanicked = errors.New("json-gold panicked")

// datasetShape is the test's own reading of what ToRDF makes of a document:
// quads over every graph, distinct blank node labels in any position, and
// the groups of blank nodes whose first-degree quads (RDFC-1.0 Hash First
// Degree Quads, compared before hashing) coincide. It exists only to prove
// the fixtures sit where their names say.
type datasetShape struct {
	quads      int
	blankNodes int
	// duplicates holds one entry per group of two or more blank nodes that
	// share their first-degree quads.
	duplicates []string
}

func measureDataset(t *testing.T, doc any, loader *DocumentLoader) datasetShape {
	t.Helper()
	out, err := ld.NewJsonLdProcessor().ToRDF(copyJSON(t, doc), jsonGoldOptions(loader))
	if err != nil {
		t.Fatalf("ToRDF: %v", err)
	}
	ds, ok := out.(*ld.RDFDataset)
	if !ok {
		t.Fatalf("ToRDF returned %T, want *ld.RDFDataset", out)
	}
	var shape datasetShape
	mentions := map[string][]*ld.Quad{}
	for _, quads := range ds.Graphs {
		for _, q := range quads {
			shape.quads++
			seen := map[string]bool{}
			for _, n := range []ld.Node{q.Subject, q.Object, q.Graph} {
				if b, ok := n.(*ld.BlankNode); ok && !seen[b.Attribute] {
					seen[b.Attribute] = true
					mentions[b.Attribute] = append(mentions[b.Attribute], q)
				}
			}
		}
	}
	shape.blankNodes = len(mentions)
	groups := map[string]int{}
	for ref, quads := range mentions {
		lines := make([]string, 0, len(quads))
		for _, q := range quads {
			lines = append(lines, strings.Join([]string{
				firstDegreeTerm(q.Subject, ref),
				firstDegreeTerm(q.Predicate, ref),
				firstDegreeTerm(q.Object, ref),
				firstDegreeTerm(q.Graph, ref),
			}, " "))
		}
		sort.Strings(lines)
		groups[strings.Join(lines, "\n")]++
	}
	for sig, n := range groups {
		if n > 1 {
			shape.duplicates = append(shape.duplicates, fmt.Sprintf("%d blank nodes share [%s]", n, strings.ReplaceAll(sig, "\n", " | ")))
		}
	}
	sort.Strings(shape.duplicates)
	return shape
}

// firstDegreeTerm writes the reference blank node as _:a and every other
// blank node as _:z, which is what makes two nodes indistinguishable at
// first degree when their neighbourhoods differ only in blank node labels.
func firstDegreeTerm(n ld.Node, ref string) string {
	switch x := n.(type) {
	case nil:
		return "@default"
	case *ld.BlankNode:
		if x.Attribute == ref {
			return "_:a"
		}
		return "_:z"
	case *ld.IRI:
		if x.Value == "@default" {
			return "@default"
		}
		return "<" + x.Value + ">"
	case *ld.Literal:
		return fmt.Sprintf("%q^^<%s>@%s", x.Value, x.Datatype, x.Language)
	}
	return fmt.Sprintf("%T(%s)", n, n.GetValue())
}

// datasetChain builds k objects nested through "source", each with m
// "destination" entries. With distinct false every level carries the same
// literals and every destination entry is identical, so the entries of one
// level are interchangeable and so are the middle levels of the chain; both
// kinds of symmetry are what make an unguarded URDNA2015 run explore
// permutations. With distinct true every account is unique.
func datasetChain(k, m int, distinct bool) map[string]any {
	level := func(i int) map[string]any {
		dest := make([]any, 0, m)
		for j := 0; j < m; j++ {
			account := "0x01"
			if distinct {
				account = fmt.Sprintf("0x%02x%02x", i+1, j+1)
			}
			dest = append(dest, map[string]any{"account": account, "asset_identifier": "eip155:1/erc20:0x01"})
		}
		account := "0x02"
		if distinct {
			account = fmt.Sprintf("0x%02x", i+1)
		}
		return map[string]any{"destination": dest, "account": account, "asset_identifier": "eip155:1/erc20:0x02"}
	}
	node := level(0)
	for i := 1; i < k; i++ {
		p := level(i)
		p["source"] = node
		node = p
	}
	return map[string]any{
		"@context":   datasetPaymentRequestContextURL,
		"request_id": "req-1",
		"source":     node,
	}
}

// datasetReach nests three levels of eight-entry destination fans inside the
// source of a real signed PaymentRequest fixture, using only terms its
// context defines, so the document is a schema-valid request that reaches
// canonicalization on the pre-authentication verify path.
func datasetReach(t *testing.T, distinct bool) map[string]any {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("cwd: %v", err)
	}
	path := filepath.Join(cwd, "..", "..", "..", "PaymentRequest", "v1", "conformance", "fixtures", "secp256k1-go-signed.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	src, ok := doc["source"].(map[string]any)
	if !ok {
		t.Fatalf("%s: source is %T, want an object", path, doc["source"])
	}
	link := func(i int, next map[string]any) map[string]any {
		fan := make([]any, 8)
		for j := range fan {
			account := "0x01"
			if distinct {
				account = fmt.Sprintf("0x%02x%02x", i+1, j+1)
			}
			fan[j] = map[string]any{"account": account, "asset_identifier": "eip155:1/erc20:0x01"}
		}
		account := "0x02"
		if distinct {
			account = fmt.Sprintf("0x%02x", i+1)
		}
		m := map[string]any{"account": account, "asset_identifier": "eip155:1/erc20:0x02", "destination": fan}
		if next != nil {
			m["source"] = next
		}
		return m
	}
	src["source"] = link(2, link(1, link(0, nil)))
	return doc
}

// datasetBlankNodeBoundary builds a PaymentRequest-context document with
// exactly 1024 blank nodes, or 1025 with extra set, inside the 1024-value
// JSON budget and with no two blank nodes alike at first degree.
//
// Only a graph container ("proof") yields more blank nodes than JSON values:
// each proof object becomes a graph name and the node inside it. The proofs
// are siblings in one array rather than a chain, so the document is six
// levels deep and far inside the depth budget:
//   - root, its @context string, the proof array and an empty "sender_auth"
//     object: 4 values, 2 blank nodes;
//   - three literal-free proof levels, the first holding only the second,
//     the second the third beside an empty "source" object, the third a
//     literal proof beside an empty "payment_request" object: 5 values,
//     8 blank nodes;
//   - 507 proofs each with its own "account" literal, one inside the third
//     literal-free level and the rest in the array: 2 values and 2 blank
//     nodes each, the literal telling apart both the proof's node and its
//     graph name;
//   - with extra, an empty "destination" object on the root: 1 value, 1
//     blank node.
//
// That is 1024 blank nodes in 1023 values, or 1025 in 1024. A literal proof
// pays for its two blank nodes with two values and the array costs one, so
// the surplus comes from the literal-free levels, each one value and two
// blank nodes. Each of them has a shape nothing else shares at first degree:
// their parents' graphs differ, and each empty object hangs under a key used
// nowhere else.
func datasetBlankNodeBoundary(extra bool) map[string]any {
	const literalProofs = 507
	third := map[string]any{"proof": map[string]any{"account": "a0"}, "payment_request": map[string]any{}}
	second := map[string]any{"proof": third, "source": map[string]any{}}
	proofs := []any{map[string]any{"proof": second}}
	for i := 1; i < literalProofs; i++ {
		proofs = append(proofs, map[string]any{"account": fmt.Sprintf("a%d", i)})
	}
	doc := map[string]any{
		"@context":    datasetPaymentRequestContextURL,
		"proof":       proofs,
		"sender_auth": map[string]any{},
	}
	if extra {
		doc["destination"] = map[string]any{}
	}
	return doc
}

// The dataset rule ids share the wire vocabulary of the JSON rules, so their
// spelling is part of the contract, and no id may collide with another rule.
func TestDatasetAdmissionRule_IDsAreTheWireStrings(t *testing.T) {
	want := map[AdmissionRule]string{
		RuleIndistinguishableBlankNodes: "indistinguishable-blank-nodes",
		RuleBlankNodeBudget:             "blank-node-budget",
		RuleOutputBudget:                "output-budget",
	}
	if len(want) != len(datasetAdmissionRules) {
		t.Fatalf("dataset rule constants are not pairwise distinct: %d distinct of %d", len(want), len(datasetAdmissionRules))
	}
	for r, s := range want {
		if string(r) != s {
			t.Errorf("rule constant = %q, want %q", string(r), s)
		}
	}
	seen := map[AdmissionRule]bool{}
	for _, r := range append(append(append([]AdmissionRule{}, allAdmissionRules...), codeOnlyAdmissionRules...), datasetAdmissionRules...) {
		if seen[r] {
			t.Errorf("rule id %q is used by two rules", r)
		}
		seen[r] = true
	}
}

// A dataset rule refuses a whole document, so its error names the rule and
// no location, and still matches ErrNotCanonicalizable through wrapping.
func TestDatasetAdmissionError_IsDocumentWide(t *testing.T) {
	for _, r := range datasetAdmissionRules {
		var err error = &AdmissionError{Rule: r, Path: ""}
		msg := err.Error()
		if !strings.Contains(msg, string(r)) || strings.Contains(msg, " at ") {
			t.Errorf("(&AdmissionError{Rule: %q}).Error() = %q, want the rule id and no \" at \"", r, msg)
		}
		if !errors.Is(fmt.Errorf("outer: %w", err), ErrNotCanonicalizable) {
			t.Errorf("wrapped &AdmissionError{Rule: %q} does not match ErrNotCanonicalizable", r)
		}
	}
}

// Guards the dataset section of the vector file: every refuse vector names
// a dataset rule with the empty path, the accept vector at the same index is
// its counterpart, and the test's own reading of each dataset agrees with
// each verdict. An indistinguishable-blank-nodes vector must have two blank
// nodes alike at first degree and an output-budget vector an estimate over
// the budget; each must also clear every dataset rule applied before its
// own, or the vector would be refused under that rule instead. Every
// counterpart clears all three rules. The chain and long-IRI vectors must be
// exactly what datasetChain and outputBudgetDoc build, so the file and the
// generated shapes described in their names cannot drift apart.
func TestDatasetVectors_FileMatchesItsStatedSemantics(t *testing.T) {
	f := loadDatasetVectors(t)
	loader := datasetLoader(t, f)
	if len(f.Dataset.Accept) != len(f.Dataset.Refuse) {
		t.Fatalf("dataset: %d accept, %d refuse; want one accept counterpart per refuse vector", len(f.Dataset.Accept), len(f.Dataset.Refuse))
	}
	known := map[string]bool{}
	for _, r := range datasetAdmissionRules {
		known[string(r)] = true
	}
	names := map[string]bool{}
	for _, list := range [][]admissionVector{f.Dataset.Accept, f.Dataset.Refuse} {
		for _, v := range list {
			if names[v.Name] {
				t.Errorf("dataset vector name %q is not unique", v.Name)
			}
			names[v.Name] = true
		}
	}
	for i, v := range f.Dataset.Refuse {
		if v.Rule == nil || !known[*v.Rule] {
			t.Errorf("dataset refuse %q: rule %v, want one of %v", v.Name, v.Rule, datasetAdmissionRules)
		}
		if v.Path == nil || *v.Path != "" {
			t.Errorf("dataset refuse %q: path %v, want the empty string", v.Name, v.Path)
		}
		if v.Rule != nil && *v.Rule == string(RuleIndistinguishableBlankNodes) {
			s := measureDataset(t, v.Doc, loader)
			if len(s.duplicates) == 0 {
				t.Errorf("dataset refuse %q: no two blank nodes share first-degree quads", v.Name)
			}
			if s.blankNodes > datasetBlankNodeBudget {
				t.Errorf("dataset refuse %q: %d blank nodes, over the budget of %d", v.Name, s.blankNodes, datasetBlankNodeBudget)
			}
			if e := measureOutputEstimate(t, v.Doc, loader); e > datasetOutputBudget {
				t.Errorf("dataset refuse %q: output estimate %d, over the budget of %d", v.Name, e, datasetOutputBudget)
			}
		}
		if v.Rule != nil && *v.Rule == string(RuleOutputBudget) {
			if e := measureOutputEstimate(t, v.Doc, loader); e <= datasetOutputBudget {
				t.Errorf("dataset refuse %q: output estimate %d, within the budget of %d", v.Name, e, datasetOutputBudget)
			}
			if s := measureDataset(t, v.Doc, loader); s.blankNodes > datasetBlankNodeBudget {
				t.Errorf("dataset refuse %q: %d blank nodes, over the budget of %d", v.Name, s.blankNodes, datasetBlankNodeBudget)
			}
		}
		acc := f.Dataset.Accept[i]
		s := measureDataset(t, acc.Doc, loader)
		if len(s.duplicates) != 0 {
			t.Errorf("dataset accept %q: %v", acc.Name, s.duplicates)
		}
		if s.blankNodes > datasetBlankNodeBudget {
			t.Errorf("dataset accept %q: %d blank nodes, over the budget of %d", acc.Name, s.blankNodes, datasetBlankNodeBudget)
		}
		if e := measureOutputEstimate(t, acc.Doc, loader); e > datasetOutputBudget {
			t.Errorf("dataset accept %q: output estimate %d, over the budget of %d", acc.Name, e, datasetOutputBudget)
		}
	}
	// The output-budget pairs are the file's only coverage of that rule, so
	// its absence must fail rather than leave the loop above vacuous.
	var outputBudgetVectors int
	for _, v := range f.Dataset.Refuse {
		if v.Rule != nil && *v.Rule == string(RuleOutputBudget) {
			outputBudgetVectors++
		}
	}
	if outputBudgetVectors == 0 {
		t.Errorf("no dataset refuse vector asserts rule %q", RuleOutputBudget)
	}
	for _, c := range []struct {
		list     []admissionVector
		prefix   string
		k, m     int
		distinct bool
	}{
		{f.Dataset.Refuse, "indistinguishable blank nodes: chain of 3 nested sources, each with 7 identical", 3, 7, false},
		{f.Dataset.Accept, "distinguishable blank nodes: chain of 3 nested sources, each with 7 destination entries, every account distinct", 3, 7, true},
		{f.Dataset.Refuse, "indistinguishable blank nodes: chain of 4 nested sources with identical literals", 4, 0, false},
		{f.Dataset.Accept, "distinguishable blank nodes: chain of 4 nested sources with distinct accounts", 4, 0, true},
	} {
		v := findDatasetVector(t, c.list, c.prefix)
		if want := copyJSON(t, datasetChain(c.k, c.m, c.distinct)); !reflect.DeepEqual(v.Doc, want) {
			t.Errorf("%q is not datasetChain(%d, %d, %v)", v.Name, c.k, c.m, c.distinct)
		}
	}
	for _, c := range []struct {
		list                    []admissionVector
		prefix                  string
		iriLen, statements, pad int
	}{
		{f.Dataset.Refuse, "output budget: one node with a 1500-byte IRI, the subject of 600 issuanceDate statements", 1500, 600, 0},
		{f.Dataset.Accept, "within the output budget: the same 1500-byte IRI, the subject of 60 issuanceDate statements", 1500, 60, 0},
		{f.Dataset.Refuse, "output budget, one byte over: one node with a 1500-byte IRI, the subject of 80 issuanceDate statements, the first padded by 819 bytes", 1500, 80, 819},
		{f.Dataset.Accept, "within the output budget, exactly at it: the same 1500-byte IRI, the subject of 80 issuanceDate statements, the first padded by 818 bytes", 1500, 80, 818},
	} {
		v := findDatasetVector(t, c.list, c.prefix)
		if want := copyJSON(t, outputBudgetDoc(c.iriLen, c.statements, 0, c.pad)); !reflect.DeepEqual(v.Doc, want) {
			t.Errorf("%q is not outputBudgetDoc(%d, %d, 0, %d)", v.Name, c.iriLen, c.statements, c.pad)
		}
	}
	// The boundary pair must sit on the budget itself, from both sides, so
	// that the file alone pins where the budget is and not only that one
	// exists.
	for _, c := range []struct {
		list   []admissionVector
		prefix string
		want   int
	}{
		{f.Dataset.Refuse, "output budget, one byte over:", datasetOutputBudget + 1},
		{f.Dataset.Accept, "within the output budget, exactly at it:", datasetOutputBudget},
	} {
		v := findDatasetVector(t, c.list, c.prefix)
		if e := measureOutputEstimate(t, v.Doc, loader); e != c.want {
			t.Errorf("%q: output estimate %d, want exactly %d", v.Name, e, c.want)
		}
	}
}

// statedEstimate reads the "(estimate N bytes)" a dataset vector's name
// states, reporting false when the name states none.
func statedEstimate(name string) (int, bool) {
	const open, close = "(estimate ", " bytes)"
	i := strings.Index(name, open)
	if i < 0 {
		return 0, false
	}
	rest := name[i+len(open):]
	j := strings.Index(rest, close)
	if j < 0 {
		return 0, false
	}
	n, err := strconv.Atoi(rest[:j])
	if err != nil {
		return 0, false
	}
	return n, true
}

// The output-budget vectors and their counterparts state their estimates in
// their names, and the estimate is defined identically in both languages, so
// each is pinned to the exact number rather than to a side of the budget: a
// drift in either language's estimator, or in the vectors, fails at once.
func TestDatasetVectors_OutputBudgetPairStatesItsExactEstimate(t *testing.T) {
	f := loadDatasetVectors(t)
	loader := datasetLoader(t, f)
	var pinned int
	for i, v := range f.Dataset.Refuse {
		if v.Rule == nil || *v.Rule != string(RuleOutputBudget) {
			continue
		}
		for _, x := range []admissionVector{v, f.Dataset.Accept[i]} {
			want, ok := statedEstimate(x.Name)
			if !ok {
				t.Errorf("dataset vector %q states no \"(estimate N bytes)\"", x.Name)
				continue
			}
			if got := measureOutputEstimate(t, x.Doc, loader); got != want {
				t.Errorf("dataset vector %q: output estimate %d, want the %d its name states", x.Name, got, want)
			}
			pinned++
		}
	}
	if pinned == 0 {
		t.Fatalf("no output-budget vector pair states its estimate")
	}
}

// The dataset rules belong to Canonicalize alone. CheckCanonicalizable
// judges only the JSON, and every dataset vector is clean JSON, so it must
// admit them all, refusals included.
func TestCheckCanonicalizable_DoesNotApplyTheDatasetRules(t *testing.T) {
	f := loadDatasetVectors(t)
	docs := append(append([]admissionVector{}, f.Dataset.Accept...), f.Dataset.Refuse...)
	docs = append(docs,
		admissionVector{Name: "reach, repeated", Doc: datasetReach(t, false)},
		admissionVector{Name: "blank-node boundary, 1025", Doc: datasetBlankNodeBoundary(true)},
		admissionVector{Name: "long IRI, estimated far over the output budget", Doc: outputBudgetDoc(40000, 1000, 0, 0)},
	)
	for _, v := range docs {
		t.Run(v.Name, func(t *testing.T) {
			if err := CheckCanonicalizable(v.Doc); err != nil {
				t.Errorf("CheckCanonicalizable = %v, want nil", err)
			}
		})
	}
}

// Each shape is refused as a whole under the rule its vector names.
// Unguarded, json-gold spends close to a second on the chain and several
// seconds on the reach document, so the 100 ms ceiling can only be met if the
// refusal comes before canonicalization starts; for the small vectors the
// ceiling is not discriminating, only the verdict is.
func TestCanonicalize_RefusesDatasetVectorsWithin100ms(t *testing.T) {
	f := loadDatasetVectors(t)
	loader := datasetLoader(t, f)
	ibn := string(RuleIndistinguishableBlankNodes)
	cases := append([]admissionVector{}, f.Dataset.Refuse...)
	cases = append(cases, admissionVector{
		Name: "indistinguishable blank nodes: signed PaymentRequest fixture with three nested eight-entry destination fans in its source",
		Rule: &ibn,
		Doc:  datasetReach(t, false),
	})
	vectorRules := map[string]bool{ibn: true, string(RuleOutputBudget): true}
	for _, v := range cases {
		t.Run(v.Name, func(t *testing.T) {
			if v.Rule == nil || !vectorRules[*v.Rule] {
				t.Fatalf("vector rule %v, want %q or %q; blank-node-budget has no vectors in the file", v.Rule, RuleIndistinguishableBlankNodes, RuleOutputBudget)
			}
			rule := AdmissionRule(*v.Rule)
			start := time.Now()
			out, err := Canonicalize(v.Doc, loader)
			elapsed := time.Since(start)
			if elapsed >= 100*time.Millisecond {
				t.Errorf("Canonicalize took %v, want < 100ms", elapsed)
			}
			if err == nil {
				t.Fatalf("Canonicalize returned %d bytes of N-Quads and a nil error; want refusal", len(out))
			}
			if out != "" {
				t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
			}
			if !errors.Is(err, ErrNotCanonicalizable) {
				t.Errorf("errors.Is(err, ErrNotCanonicalizable) = false for %v", err)
			}
			var ae *AdmissionError
			if !errors.As(err, &ae) {
				t.Fatalf("err = %T %v, want *AdmissionError", err, err)
			}
			if ae.Rule != rule || ae.Path != "" {
				t.Errorf("AdmissionError = {%q %q}, want {%q \"\"}", ae.Rule, ae.Path, rule)
			}
		})
	}
}

// The counterparts of every refused shape are admitted, and canonicalize to
// exactly what json-gold produces on its own.
func TestCanonicalize_AdmitsDistinguishableCounterpartsByteIdentically(t *testing.T) {
	f := loadDatasetVectors(t)
	loader := datasetLoader(t, f)
	cases := append([]admissionVector{}, f.Dataset.Accept...)
	cases = append(cases, admissionVector{
		Name: "distinguishable blank nodes: signed PaymentRequest fixture with three nested eight-entry destination fans, every account distinct",
		Doc:  datasetReach(t, true),
	})
	for _, v := range cases {
		t.Run(v.Name, func(t *testing.T) {
			if s := measureDataset(t, v.Doc, loader); len(s.duplicates) != 0 {
				t.Fatalf("fixture has indistinguishable blank nodes: %v", s.duplicates)
			}
			got, err := Canonicalize(copyJSON(t, v.Doc), loader)
			if err != nil {
				t.Fatalf("Canonicalize = %v, want admission", err)
			}
			want, err := referenceNormalize(copyJSON(t, v.Doc), loader)
			if err != nil {
				t.Fatalf("reference Normalize: %v", err)
			}
			if got == "" {
				t.Errorf("Canonicalize returned empty N-Quads for a document with RDF")
			}
			if got != want {
				t.Errorf("Canonicalize output differs from json-gold Normalize\n--- Canonicalize ---\n%s\n--- Normalize ---\n%s", got, want)
			}
		})
	}
}

// Byte identity over every accept vector, under the bare vendored loader and
// under the loader with the PaymentRequest context: wherever json-gold
// normalizes the document, Canonicalize must admit it and return the same
// bytes; wherever json-gold fails (an unregistered @context), Canonicalize
// must fail too, and not by calling the document inadmissible. The accept
// vectors built on undefined keys yield no RDF at all and must stay
// admitted.
func TestCanonicalize_AcceptVectorsMatchJSONGoldNormalize(t *testing.T) {
	f := loadAdmissionVectors(t)
	loaders := []struct {
		name   string
		loader *DocumentLoader
	}{
		{"vendored", NewDocumentLoader(nil)},
		{"with PaymentRequest context", datasetLoader(t, loadDatasetVectors(t))},
	}
	compared := 0
	for _, l := range loaders {
		for _, v := range f.Accept {
			t.Run(l.name+"/"+v.Name, func(t *testing.T) {
				want, wantErr := referenceNormalize(copyJSON(t, v.Doc), l.loader)
				got, err := Canonicalize(copyJSON(t, v.Doc), l.loader)
				if wantErr != nil {
					if err == nil {
						t.Errorf("Canonicalize admitted a document json-gold fails on (%v)", wantErr)
					} else if errors.Is(err, ErrNotCanonicalizable) {
						t.Errorf("Canonicalize refused an accept vector: %v", err)
					}
					return
				}
				compared++
				if err != nil {
					t.Fatalf("Canonicalize = %v, want the %d bytes json-gold produces", err, len(want))
				}
				if got != want {
					t.Errorf("Canonicalize output differs from json-gold Normalize\n--- Canonicalize ---\n%s\n--- Normalize ---\n%s", got, want)
				}
			})
		}
	}
	// Most accept vectors name no @context, so a loader bug cannot empty the
	// comparison without this firing.
	if compared < len(f.Accept) {
		t.Errorf("compared %d accept vectors against json-gold, want at least %d", compared, len(f.Accept))
	}
}

// Byte identity over every JSON-LD document the protocol already signs that
// the vendored loader can resolve. None of them has indistinguishable blank
// nodes or approaches a dataset cap, so each must be admitted with its
// canonical bytes, and every golden hash built on them, unchanged.
func TestCanonicalize_ProtocolCorpusMatchesJSONGoldNormalize(t *testing.T) {
	loader := NewDocumentLoader(nil)
	compared := 0
	for _, d := range datasetProtocolCorpus(t) {
		want, wantErr := referenceNormalize(copyJSON(t, d.doc), loader)
		got, err := Canonicalize(copyJSON(t, d.doc), loader)
		if wantErr != nil {
			if err == nil {
				t.Errorf("%s: Canonicalize admitted a document json-gold fails on (%v)", d.name, wantErr)
			}
			continue
		}
		compared++
		if err != nil {
			t.Errorf("%s: Canonicalize = %v, want the %d bytes json-gold produces", d.name, err, len(want))
			continue
		}
		if got != want {
			t.Errorf("%s: Canonicalize output differs from json-gold Normalize\n--- Canonicalize ---\n%s\n--- Normalize ---\n%s", d.name, got, want)
		}
	}
	// The vendored loader resolves the four signed credential fixtures
	// under FulfillmentQuote's conformance tree.
	if compared < 4 {
		t.Fatalf("compared %d corpus documents against json-gold, want at least 4", compared)
	}
}

type datasetCorpusDocument struct {
	name string
	doc  map[string]any
}

// datasetProtocolCorpus is the corpus TestCheckCanonicalizable_AdmitsExistingProtocolDocuments
// walks: each outermost object carrying "@context" in every declaration's
// example, conformance tree, and Go bindings' testdata.
func datasetProtocolCorpus(t *testing.T) []datasetCorpusDocument {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("cwd: %v", err)
	}
	declarations, err := filepath.Abs(filepath.Join(cwd, "..", "..", ".."))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	var docs []datasetCorpusDocument
	err = filepath.WalkDir(declarations, func(path string, d fs.DirEntry, err error) error {
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
		rel, err := filepath.Rel(declarations, path)
		if err != nil {
			return err
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		if len(parts) < 3 || parts[1] != "v1" {
			return nil
		}
		switch {
		case len(parts) == 3 && parts[2] == "example.json":
		case parts[2] == "conformance":
		case len(parts) > 4 && parts[2] == "bindings" && parts[3] == "go" && contains(parts[4:len(parts)-1], "testdata"):
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
		forEachJSONLDDocument(v, "", func(ptr string, doc map[string]any) {
			docs = append(docs, datasetCorpusDocument{name: rel + "#" + ptr, doc: doc})
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", declarations, err)
	}
	if len(docs) < 10 {
		t.Fatalf("found %d JSON-LD documents under %s, want at least 10", len(docs), declarations)
	}
	return docs
}

// The blank-node cap from both sides. The fixtures are measured here with
// ToRDF so an edit to the builder cannot move them off the boundary, and
// they are checked to have no indistinguishable blank nodes, so the only
// rule the refused one can break is the blank-node cap.
func TestCanonicalize_BlankNodeBudgetBoundary(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	for _, c := range []struct {
		name   string
		extra  bool
		want   int
		refuse bool
	}{
		{"exactly 1024 blank nodes is admitted", false, datasetBlankNodeBudget, false},
		{"1025 blank nodes is refused", true, datasetBlankNodeBudget + 1, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			doc := datasetBlankNodeBoundary(c.extra)
			if err := CheckCanonicalizable(doc); err != nil {
				t.Fatalf("fixture fails the JSON pre-check: %v", err)
			}
			if d := jsonDepth(doc); d > admissionDepthBudget {
				t.Fatalf("fixture is %d levels deep, over the depth budget of %d", d, admissionDepthBudget)
			}
			s := measureDataset(t, doc, loader)
			if s.blankNodes != c.want {
				t.Fatalf("fixture has %d blank nodes, want %d", s.blankNodes, c.want)
			}
			if len(s.duplicates) != 0 {
				t.Fatalf("fixture has indistinguishable blank nodes: %v", s.duplicates)
			}

			got, err := Canonicalize(copyJSON(t, doc), loader)
			if !c.refuse {
				if err != nil {
					t.Fatalf("Canonicalize = %v, want admission", err)
				}
				want, err := referenceNormalize(copyJSON(t, doc), loader)
				if err != nil {
					t.Fatalf("reference Normalize: %v", err)
				}
				if got != want {
					t.Errorf("Canonicalize output (%d bytes) differs from json-gold Normalize (%d bytes)", len(got), len(want))
				}
				return
			}
			if err == nil {
				t.Fatalf("Canonicalize returned %d bytes of N-Quads and a nil error; want refusal", len(got))
			}
			if got != "" {
				t.Errorf("Canonicalize output is %d bytes alongside an error, want empty", len(got))
			}
			var ae *AdmissionError
			if !errors.As(err, &ae) {
				t.Fatalf("err = %T %v, want *AdmissionError", err, err)
			}
			if ae.Rule != RuleBlankNodeBudget || ae.Path != "" {
				t.Errorf("AdmissionError = {%q %q}, want {%q \"\"}", ae.Rule, ae.Path, RuleBlankNodeBudget)
			}
		})
	}
}

// toRDFQuadCount is the number of quads json-gold's ToRDF yields for doc,
// every graph counted.
func toRDFQuadCount(t *testing.T, doc any, loader *DocumentLoader) (n int, err error) {
	t.Helper()
	// Recovered for the reason referenceNormalize gives.
	defer func() {
		if r := recover(); r != nil {
			n, err = 0, fmt.Errorf("%w: %v", errJSONGoldPanicked, r)
		}
	}()
	out, err := ld.NewJsonLdProcessor().ToRDF(copyJSON(t, doc), jsonGoldOptions(loader))
	if err != nil {
		return 0, err
	}
	ds, ok := out.(*ld.RDFDataset)
	if !ok {
		return 0, fmt.Errorf("ToRDF returned %T, want *ld.RDFDataset", out)
	}
	n = 0
	for _, quads := range ds.Graphs {
		n += len(quads)
	}
	return n, nil
}

// There is no statement cap because the value budget is meant to bound the
// statement count: each JSON value contributes at most the one quad linking
// it to its parent, so a document yields no more quads than it has values.
// That holds only while the contexts avoid the keywords the next test bans,
// so it is checked here on every JSON-LD document the tests use, and a
// context or fixture that breaks it fails here instead of letting the quad
// count outgrow the value budget unnoticed.
func TestToRDF_QuadCountNeverExceedsJSONValueCount(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	type doc struct {
		name string
		doc  any
		// mustExpand is false only for accept vectors, some of which name a
		// @context no loader resolves and so yield no dataset at all.
		mustExpand bool
	}
	var docs []doc
	af := loadAdmissionVectors(t)
	for _, v := range af.Accept {
		docs = append(docs, doc{"accept/" + v.Name, v.Doc, false})
	}
	for _, g := range af.Generated.Accept {
		expanded, err := expandAdmissionTemplate(g.Doc)
		if err != nil {
			t.Fatalf("generated accept %q: %v", g.Name, err)
		}
		docs = append(docs, doc{"generated accept/" + g.Name, expanded, false})
	}
	df := loadDatasetVectors(t)
	for _, v := range df.Dataset.Accept {
		docs = append(docs, doc{"dataset accept/" + v.Name, v.Doc, true})
	}
	for _, v := range df.Dataset.Refuse {
		docs = append(docs, doc{"dataset refuse/" + v.Name, v.Doc, true})
	}
	docs = append(docs,
		doc{"reach, repeated", datasetReach(t, false), true},
		doc{"reach, distinct", datasetReach(t, true), true},
		doc{"blank-node boundary, 1024", datasetBlankNodeBoundary(false), true},
		doc{"blank-node boundary, 1025", datasetBlankNodeBoundary(true), true},
	)
	corpus := datasetProtocolCorpus(t)
	for _, d := range corpus {
		docs = append(docs, doc{"corpus/" + d.name, d.doc, false})
	}

	measured, corpusMeasured, maxQuads := 0, 0, 0
	for _, d := range docs {
		values := countJSONValues(copyJSON(t, d.doc))
		quads, err := toRDFQuadCount(t, d.doc, loader)
		if err != nil {
			if d.mustExpand {
				t.Errorf("%s: ToRDF: %v", d.name, err)
			}
			continue
		}
		measured++
		if strings.HasPrefix(d.name, "corpus/") {
			corpusMeasured++
		}
		if quads > maxQuads {
			maxQuads = quads
		}
		if quads > values {
			t.Errorf("%s: ToRDF yields %d quads from %d JSON values", d.name, quads, values)
		}
	}
	t.Logf("measured %d of %d documents; largest dataset %d quads", measured, len(docs), maxQuads)
	// The same floor the corpus byte-identity test relies on: the four signed
	// credential fixtures the vendored loader resolves.
	if corpusMeasured < 4 {
		t.Errorf("measured %d corpus documents, want at least 4", corpusMeasured)
	}
	// Every accept vector with no @context, or with one the loader resolves,
	// must be measured, so a loader regression cannot empty the check.
	if measured < len(af.Accept) {
		t.Errorf("measured %d documents, want at least the %d accept vectors", measured, len(af.Accept))
	}
}

// The quad bound above was measured only against contexts that use none of
// @list, @reverse, @nest and @index. @list breaks it outright, since every
// list member yields both an rdf:first and an rdf:rest quad; the other three
// change how the JSON tree maps onto nodes and edges, so the bound says
// nothing about documents that use them. Every *.jsonld under the schemas
// tree is scanned, keys and string values alike, so a term definition such
// as "@container": "@list" is caught as well as a keyword used as a key.
func TestShippedContexts_UseNoKeywordThatBreaksTheQuadBound(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("cwd: %v", err)
	}
	schemas, err := filepath.Abs(filepath.Join(cwd, "..", "..", "..", ".."))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	forbidden := map[string]bool{"@list": true, "@reverse": true, "@nest": true, "@index": true}
	var find func(v any, ptr string, hit func(ptr, kw string))
	find = func(v any, ptr string, hit func(ptr, kw string)) {
		switch x := v.(type) {
		case string:
			if forbidden[x] {
				hit(ptr, x)
			}
		case map[string]any:
			for k, c := range x {
				if forbidden[k] {
					hit(ptr+"/"+k, k)
				}
				find(c, ptr+"/"+k, hit)
			}
		case []any:
			for i, c := range x {
				find(c, fmt.Sprintf("%s/%d", ptr, i), hit)
			}
		}
	}
	var scanned []string
	err = filepath.WalkDir(schemas, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "node_modules" || d.Name() == "dist" {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".jsonld" {
			return nil
		}
		rel, err := filepath.Rel(schemas, path)
		if err != nil {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("parse %s: %w", rel, err)
		}
		scanned = append(scanned, rel)
		find(v, "", func(ptr, kw string) {
			t.Errorf("%s#%s uses %s", rel, ptr, kw)
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", schemas, err)
	}
	sort.Strings(scanned)
	t.Logf("scanned %d context files under %s:\n%s", len(scanned), schemas, strings.Join(scanned, "\n"))
	if len(scanned) < 5 {
		t.Fatalf("scanned %d context files, want at least 5", len(scanned))
	}
}

// The output cap as the contract states it: 128 KiB of estimated canonical
// N-Quads. Restated rather than imported, like datasetBlankNodeBudget.
const datasetOutputBudget = 128 << 10

// canonicalLabelPrefix is the fixed part of every label URDNA2015 issues:
// the n blank nodes of a dataset are relabelled _:c14n0 through _:c14n(n-1).
const canonicalLabelPrefix = "_:c14n"

// outputEstimate is the test's own computation of the output-budget
// estimate. Each quad contributes its N-Quad line as json-gold serializes
// it, with every blank-node label in the subject, object and graph
// positions counted at the width of the widest canonical label instead of
// its ToRDF label. No issued label is wider, so the sum bounds the
// canonical output from above. Blank nodes are counted over the quads, as
// the dataset rules see them.
func outputEstimate(doc any, loader *DocumentLoader) (int, error) {
	out, err := ld.NewJsonLdProcessor().ToRDF(doc, jsonGoldOptions(loader))
	if err != nil {
		return 0, err
	}
	ds, ok := out.(*ld.RDFDataset)
	if !ok {
		return 0, fmt.Errorf("ToRDF returned %T, want *ld.RDFDataset", out)
	}
	blank := func(n ld.Node) (string, bool) {
		if b, ok := n.(*ld.BlankNode); ok {
			return b.Attribute, true
		}
		return "", false
	}
	labels := map[string]bool{}
	for graph, quads := range ds.Graphs {
		for _, q := range quads {
			if strings.HasPrefix(graph, "_:") {
				labels[graph] = true
			}
			for _, n := range []ld.Node{q.Subject, q.Object} {
				if l, ok := blank(n); ok {
					labels[l] = true
				}
			}
		}
	}
	width := 0
	if len(labels) > 0 {
		width = len(canonicalLabelPrefix) + len(strconv.Itoa(len(labels)-1))
	}
	total := 0
	ser := &ld.NQuadRDFSerializer{}
	for graph, quads := range ds.Graphs {
		for _, q := range quads {
			line, err := ser.Serialize(&ld.RDFDataset{Graphs: map[string][]*ld.Quad{graph: {q}}})
			if err != nil {
				return 0, err
			}
			s, ok := line.(string)
			if !ok {
				return 0, fmt.Errorf("Serialize returned %T, want string", line)
			}
			total += len(s)
			for _, n := range []ld.Node{q.Subject, q.Object} {
				if l, ok := blank(n); ok {
					total += width - len(l)
				}
			}
			if strings.HasPrefix(graph, "_:") {
				total += width - len(graph)
			}
		}
	}
	return total, nil
}

func measureOutputEstimate(t *testing.T, doc any, loader *DocumentLoader) int {
	t.Helper()
	n, err := outputEstimate(copyJSON(t, doc), loader)
	if err != nil {
		t.Fatalf("output estimate: %v", err)
	}
	return n
}

// outputBudgetIRIPrefix opens the long IRI of outputBudgetDoc; the rest of
// the IRI is filler. The scheme is not http or https because json-gold drops
// an http(s) IRI of 2083 or more characters as invalid, which would cap the
// shape below the lengths the early-exit test needs; it validates no other
// scheme.
const outputBudgetIRIPrefix = "urn:example:"

// outputBudgetDoc is the shape the output budget exists for: one node whose
// IRI is iriLen bytes long, typed VerifiableCredential so the credentials
// context defines issuanceDate on it, and the subject of one issuanceDate
// statement per literal. Every statement repeats the IRI in the output while
// the JSON carries it once, so the output grows as statements times iriLen.
//
// subjects adds that many credentialSubject entries, each a blank node told
// apart by its own issuanceDate literal, so that blank-node labels occur in
// the subject and object positions. pad lengthens the first literal, which
// the output carries once, so an estimate can be moved one byte at a time.
func outputBudgetDoc(iriLen, statements, subjects, pad int) map[string]any {
	if iriLen < len(outputBudgetIRIPrefix) || statements < 1 {
		panic(fmt.Sprintf("outputBudgetDoc(%d, %d, ...): IRI shorter than its prefix or no statements", iriLen, statements))
	}
	dates := make([]any, statements)
	for i := range dates {
		dates[i] = fmt.Sprintf("%04d", i)
	}
	dates[0] = dates[0].(string) + strings.Repeat("x", pad)
	doc := map[string]any{
		"@context":     W3CVCV1ContextURL,
		"id":           outputBudgetIRIPrefix + strings.Repeat("i", iriLen-len(outputBudgetIRIPrefix)),
		"type":         "VerifiableCredential",
		"issuanceDate": dates,
	}
	if subjects > 0 {
		cs := make([]any, subjects)
		for j := range cs {
			cs[j] = map[string]any{"type": "VerifiableCredential", "issuanceDate": fmt.Sprintf("s%d", j)}
		}
		doc["credentialSubject"] = cs
	}
	return doc
}

// outputBudgetDocAt builds outputBudgetDoc with the given statements and
// subjects and an estimate of exactly target: the IRI is grown to the
// longest that keeps the estimate within target, and the first literal
// padded by the remainder. It reports an error rather than a document that
// misses the target.
func outputBudgetDocAt(statements, subjects, target int, loader *DocumentLoader) (map[string]any, error) {
	// The search starts from the shortest IRI the shape allows: with every
	// statement the value budget admits, an estimate at the budget leaves
	// each line little more than its fixed text, so the IRI is short.
	base := len(outputBudgetIRIPrefix)
	estimate := func(iriLen, pad int) (int, error) {
		return outputEstimate(outputBudgetDoc(iriLen, statements, subjects, pad), loader)
	}
	e0, err := estimate(base, 0)
	if err != nil {
		return nil, err
	}
	e1, err := estimate(base+1, 0)
	if err != nil {
		return nil, err
	}
	step := e1 - e0
	if step <= 0 || target < e0 {
		return nil, fmt.Errorf("estimate %d at IRI length %d grows by %d per byte; cannot reach %d", e0, base, step, target)
	}
	iriLen := base + (target-e0)/step
	e, err := estimate(iriLen, 0)
	if err != nil {
		return nil, err
	}
	pad := target - e
	if pad < 0 {
		return nil, fmt.Errorf("estimate %d at IRI length %d is over the target %d", e, iriLen, target)
	}
	doc := outputBudgetDoc(iriLen, statements, subjects, pad)
	if got, err := outputEstimate(doc, loader); err != nil || got != target {
		return nil, fmt.Errorf("built a document estimated at %d (err %v), want %d", got, err, target)
	}
	return doc, nil
}

func mustOutputBudgetDocAt(t *testing.T, statements, subjects, target int, loader *DocumentLoader) map[string]any {
	t.Helper()
	doc, err := outputBudgetDocAt(statements, subjects, target, loader)
	if err != nil {
		t.Fatalf("outputBudgetDocAt(%d, %d, %d): %v", statements, subjects, target, err)
	}
	return doc
}

// nestedProofs is m proof objects, each holding the next. The credentials
// context declares proof a graph container, so each level is both a graph
// name and the node inside it: about two blank nodes per JSON value, which
// puts a document over the blank-node budget inside the value budget. The
// innermost node carries a type because jsonld.js drops an empty graph, and
// with it every level enclosing only that graph, where json-gold keeps them.
func nestedProofs(m int) map[string]any {
	next := map[string]any{"type": "VerifiableCredential"}
	for i := 0; i < m; i++ {
		next = map[string]any{"proof": next}
	}
	return next
}

// proofChains is k sibling copies of nestedProofs(m), for a value of the
// credentials context's proof term: k(m+1) proof objects, each a graph name
// and a node, in k(m+2)+1 values and m+2 levels below the array's parent.
func proofChains(k, m int) []any {
	chains := make([]any, k)
	for i := range chains {
		chains[i] = nestedProofs(m)
	}
	return chains
}

func wantAdmissionRefusal(t *testing.T, out string, err error, rule AdmissionRule) {
	t.Helper()
	if err == nil {
		t.Fatalf("Canonicalize returned %d bytes of N-Quads and a nil error; want refusal", len(out))
	}
	if out != "" {
		t.Errorf("Canonicalize output is %d bytes alongside an error, want empty", len(out))
	}
	if !errors.Is(err, ErrNotCanonicalizable) {
		t.Errorf("errors.Is(err, ErrNotCanonicalizable) = false for %v", err)
	}
	var ae *AdmissionError
	if !errors.As(err, &ae) {
		t.Fatalf("err = %T %v, want *AdmissionError", err, err)
	}
	if ae.Rule != rule || ae.Path != "" {
		t.Errorf("AdmissionError = {%q %q}, want {%q \"\"}", ae.Rule, ae.Path, rule)
	}
}

// The output cap from both sides, for a dataset without blank nodes and for
// one whose blank-node labels occur as subject and object. Each fixture is
// built and measured with the test's own estimator, so an edit to the
// builder cannot move it off the boundary, and each is checked to break no
// other rule, so the only rule the refused one can break is the output cap.
//
// Ten blank nodes make every canonical label seven bytes long, where the
// ToRDF labels are four: an estimate that kept ToRDF's labels, or sized the
// canonical ones by the digits of n rather than of n-1, would land off the
// boundary and flip one of the verdicts.
func TestCanonicalize_OutputBudgetBoundary(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	for _, shape := range []struct {
		name                 string
		statements, subjects int
	}{
		{"no blank nodes", 500, 0},
		{"ten blank nodes", 500, 10},
	} {
		for _, c := range []struct {
			name   string
			target int
			refuse bool
		}{
			{"estimate of exactly the budget is admitted", datasetOutputBudget, false},
			{"estimate of one byte over the budget is refused", datasetOutputBudget + 1, true},
		} {
			t.Run(shape.name+"/"+c.name, func(t *testing.T) {
				doc := mustOutputBudgetDocAt(t, shape.statements, shape.subjects, c.target, loader)
				if err := CheckCanonicalizable(copyJSON(t, doc)); err != nil {
					t.Fatalf("fixture fails the JSON pre-check: %v", err)
				}
				s := measureDataset(t, doc, loader)
				if s.blankNodes != shape.subjects {
					t.Fatalf("fixture has %d blank nodes, want %d", s.blankNodes, shape.subjects)
				}
				if len(s.duplicates) != 0 {
					t.Fatalf("fixture has indistinguishable blank nodes: %v", s.duplicates)
				}
				estimate := measureOutputEstimate(t, doc, loader)
				if estimate != c.target {
					t.Fatalf("fixture is estimated at %d bytes, want %d", estimate, c.target)
				}

				got, err := Canonicalize(copyJSON(t, doc), loader)
				if c.refuse {
					wantAdmissionRefusal(t, got, err, RuleOutputBudget)
					return
				}
				if err != nil {
					t.Fatalf("Canonicalize = %v, want admission", err)
				}
				want, err := referenceNormalize(copyJSON(t, doc), loader)
				if err != nil {
					t.Fatalf("reference Normalize: %v", err)
				}
				if got != want {
					t.Errorf("Canonicalize output (%d bytes) differs from json-gold Normalize (%d bytes)", len(got), len(want))
				}
				if len(want) > estimate {
					t.Errorf("canonical output is %d bytes, over its estimate of %d", len(want), estimate)
				}
				// With no blank node to relabel, the canonical output is the
				// dataset's own lines sorted, so the estimate is its exact
				// length; anything else is a fault in the estimator itself.
				if shape.subjects == 0 && len(want) != estimate {
					t.Errorf("canonical output of a dataset without blank nodes is %d bytes, want exactly its estimate of %d", len(want), estimate)
				}
			})
		}
	}
}

// outputBudgetMultibyte is one character of each UTF-8 width above one byte:
// é (2 bytes), € (3 bytes) and 😀 (4 bytes, a surrogate pair in UTF-16). An
// estimate that measured a line in UTF-16 code units or code points, or
// mis-sized any one width, would count this suffix short. None of them is
// escaped by either library's N-Quads serializer.
const outputBudgetMultibyte = "é€\U0001F600"

// outputBudgetGraphDoc widens outputBudgetDoc to the named-graph and
// non-ASCII cases. The node with the iriLen-byte IRI is the subject of
// statements issuanceDate statements in the default graph and, when
// graphStatements is positive, of graphStatements more inside its proof,
// which the credentials context declares a graph container: those quads sit
// in a graph named by a blank node, so their graph term both lengthens every
// line and carries a label the estimate must widen. When multibyte is set,
// every literal carries outputBudgetMultibyte. pad lengthens the first
// literal with ASCII so an estimate can be moved one byte at a time.
func outputBudgetGraphDoc(iriLen, statements, graphStatements int, multibyte bool, pad int) map[string]any {
	if iriLen < len(outputBudgetIRIPrefix) || statements < 1 {
		panic(fmt.Sprintf("outputBudgetGraphDoc(%d, %d, ...): IRI shorter than its prefix or no statements", iriLen, statements))
	}
	suffix := ""
	if multibyte {
		suffix = outputBudgetMultibyte
	}
	literals := func(prefix string, n int) []any {
		out := make([]any, n)
		for i := range out {
			out[i] = fmt.Sprintf("%s%04d%s", prefix, i, suffix)
		}
		return out
	}
	iri := outputBudgetIRIPrefix + strings.Repeat("i", iriLen-len(outputBudgetIRIPrefix))
	dates := literals("", statements)
	dates[0] = dates[0].(string) + strings.Repeat("x", pad)
	doc := map[string]any{
		"@context":     W3CVCV1ContextURL,
		"id":           iri,
		"type":         "VerifiableCredential",
		"issuanceDate": dates,
	}
	if graphStatements > 0 {
		doc["proof"] = map[string]any{
			"id":           iri,
			"type":         "VerifiableCredential",
			"issuanceDate": literals("g", graphStatements),
		}
	}
	return doc
}

// outputBudgetGraphDocAt is outputBudgetDocAt for outputBudgetGraphDoc: the
// IRI is grown to the longest that keeps the estimate within target and the
// first literal padded by the remainder, or an error is reported.
func outputBudgetGraphDocAt(statements, graphStatements int, multibyte bool, target int, loader *DocumentLoader) (map[string]any, error) {
	const base = 100
	estimate := func(iriLen, pad int) (int, error) {
		return outputEstimate(outputBudgetGraphDoc(iriLen, statements, graphStatements, multibyte, pad), loader)
	}
	e0, err := estimate(base, 0)
	if err != nil {
		return nil, err
	}
	e1, err := estimate(base+1, 0)
	if err != nil {
		return nil, err
	}
	step := e1 - e0
	if step <= 0 || target < e0 {
		return nil, fmt.Errorf("estimate %d at IRI length %d grows by %d per byte; cannot reach %d", e0, base, step, target)
	}
	iriLen := base + (target-e0)/step
	e, err := estimate(iriLen, 0)
	if err != nil {
		return nil, err
	}
	pad := target - e
	if pad < 0 {
		return nil, fmt.Errorf("estimate %d at IRI length %d is over the target %d", e, iriLen, target)
	}
	doc := outputBudgetGraphDoc(iriLen, statements, graphStatements, multibyte, pad)
	if got, err := outputEstimate(doc, loader); err != nil || got != target {
		return nil, fmt.Errorf("built a document estimated at %d (err %v), want %d", got, err, target)
	}
	return doc, nil
}

// graphAndTextShare is the test's reading of how much of a dataset the
// named-graph and non-ASCII cases reach: the quads in a graph named by a
// blank node, the part of the estimate they contribute, and the literals
// carrying outputBudgetMultibyte.
type graphAndTextShare struct {
	blankGraphQuads, blankGraphEstimate, multibyteLiterals int
}

func measureGraphAndTextShare(t *testing.T, doc any, loader *DocumentLoader) graphAndTextShare {
	t.Helper()
	out, err := ld.NewJsonLdProcessor().ToRDF(copyJSON(t, doc), jsonGoldOptions(loader))
	if err != nil {
		t.Fatalf("ToRDF: %v", err)
	}
	ds, ok := out.(*ld.RDFDataset)
	if !ok {
		t.Fatalf("ToRDF returned %T, want *ld.RDFDataset", out)
	}
	var share graphAndTextShare
	blankGraphs := &ld.RDFDataset{Graphs: map[string][]*ld.Quad{}}
	for graph, quads := range ds.Graphs {
		for _, q := range quads {
			if l, ok := q.Object.(*ld.Literal); ok && strings.Contains(l.Value, outputBudgetMultibyte) {
				share.multibyteLiterals++
			}
		}
		if strings.HasPrefix(graph, "_:") {
			share.blankGraphQuads += len(quads)
			blankGraphs.Graphs[graph] = quads
		}
	}
	if len(blankGraphs.Graphs) == 0 {
		return share
	}
	// The named-graph lines are estimated on their own at the dataset's own
	// label width, which is what they add to the whole estimate.
	width := len(canonicalLabelPrefix) + len(strconv.Itoa(measureDataset(t, doc, loader).blankNodes-1))
	ser := &ld.NQuadRDFSerializer{}
	for graph, quads := range blankGraphs.Graphs {
		for _, q := range quads {
			line, err := ser.Serialize(&ld.RDFDataset{Graphs: map[string][]*ld.Quad{graph: {q}}})
			if err != nil {
				t.Fatalf("Serialize: %v", err)
			}
			share.blankGraphEstimate += len(line.(string)) + width - len(graph)
			for _, n := range []ld.Node{q.Subject, q.Object} {
				if b, ok := n.(*ld.BlankNode); ok {
					share.blankGraphEstimate += width - len(b.Attribute)
				}
			}
		}
	}
	return share
}

// The output cap from both sides for the cases the single-graph ASCII
// fixtures cannot see: quads inside a graph named by a blank node, literals
// of multi-byte UTF-8 characters, and both at once. Most of the estimate of
// each named-graph fixture comes from the named graph, so an estimate that
// left out the graph term, or kept the graph name's shorter ToRDF label,
// would fall short of the refused fixture's and admit it; likewise one that
// measured the multi-byte characters in anything but UTF-8 bytes.
func TestCanonicalize_OutputBudgetBoundaryNamedGraphsAndMultibyteText(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	for _, shape := range []struct {
		name                        string
		statements, graphStatements int
		multibyte                   bool
	}{
		{"named graph with a blank name", 100, 400, false},
		{"multi-byte UTF-8 literals", 500, 0, true},
		{"multi-byte UTF-8 literals in a named graph with a blank name", 100, 400, true},
	} {
		for _, c := range []struct {
			name   string
			target int
			refuse bool
		}{
			{"estimate of exactly the budget is admitted", datasetOutputBudget, false},
			{"estimate of one byte over the budget is refused", datasetOutputBudget + 1, true},
		} {
			t.Run(shape.name+"/"+c.name, func(t *testing.T) {
				doc, err := outputBudgetGraphDocAt(shape.statements, shape.graphStatements, shape.multibyte, c.target, loader)
				if err != nil {
					t.Fatalf("outputBudgetGraphDocAt(%d, %d, %v, %d): %v", shape.statements, shape.graphStatements, shape.multibyte, c.target, err)
				}
				if err := CheckCanonicalizable(copyJSON(t, doc)); err != nil {
					t.Fatalf("fixture fails the JSON pre-check: %v", err)
				}
				s := measureDataset(t, doc, loader)
				wantBlank := 0
				if shape.graphStatements > 0 {
					wantBlank = 1
				}
				if s.blankNodes != wantBlank {
					t.Fatalf("fixture has %d blank nodes, want %d", s.blankNodes, wantBlank)
				}
				if len(s.duplicates) != 0 {
					t.Fatalf("fixture has indistinguishable blank nodes: %v", s.duplicates)
				}
				estimate := measureOutputEstimate(t, doc, loader)
				if estimate != c.target {
					t.Fatalf("fixture is estimated at %d bytes, want %d", estimate, c.target)
				}
				share := measureGraphAndTextShare(t, doc, loader)
				// The proof graph holds each of its statements and the node's type.
				if want := shape.graphStatements + min(shape.graphStatements, 1); share.blankGraphQuads != want {
					t.Fatalf("fixture has %d quads in a blank-named graph, want %d", share.blankGraphQuads, want)
				}
				if shape.graphStatements > 0 && 2*share.blankGraphEstimate <= estimate {
					t.Fatalf("named graph contributes %d of the %d-byte estimate, want more than half", share.blankGraphEstimate, estimate)
				}
				wantMultibyte := 0
				if shape.multibyte {
					wantMultibyte = shape.statements + shape.graphStatements
				}
				if share.multibyteLiterals != wantMultibyte {
					t.Fatalf("fixture has %d literals carrying %q, want %d", share.multibyteLiterals, outputBudgetMultibyte, wantMultibyte)
				}

				got, err := Canonicalize(copyJSON(t, doc), loader)
				if c.refuse {
					wantAdmissionRefusal(t, got, err, RuleOutputBudget)
					return
				}
				if err != nil {
					t.Fatalf("Canonicalize = %v, want admission", err)
				}
				want, err := referenceNormalize(copyJSON(t, doc), loader)
				if err != nil {
					t.Fatalf("reference Normalize: %v", err)
				}
				if got != want {
					t.Errorf("Canonicalize output (%d bytes) differs from json-gold Normalize (%d bytes)", len(got), len(want))
				}
				if len(want) > estimate {
					t.Errorf("canonical output is %d bytes, over its estimate of %d", len(want), estimate)
				}
				if wantMultibyte > 0 && strings.Count(want, outputBudgetMultibyte) != wantMultibyte {
					t.Errorf("canonical output carries %q %d times, want %d", outputBudgetMultibyte, strings.Count(want, outputBudgetMultibyte), wantMultibyte)
				}
				// Without a blank node the canonical output is the dataset's
				// own lines sorted, so the estimate is its exact length.
				if wantBlank == 0 && len(want) != estimate {
					t.Errorf("canonical output of a dataset without blank nodes is %d bytes, want exactly its estimate of %d", len(want), estimate)
				}
			})
		}
	}
}

// Canonicalize applies the dataset rules in a fixed order: the blank-node
// budget, then the output budget, then indistinguishable blank nodes. Each
// fixture breaks two of them, measured here so that it cannot silently stop
// breaking either.
func TestCanonicalize_OutputBudgetPrecedence(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))

	t.Run("over the blank-node budget and the output budget reports blank-node-budget", func(t *testing.T) {
		// Many short chains rather than a few long ones, so the document
		// stays inside the depth budget: 25 chains of 21 proofs are 1050
		// blank nodes in 551 values, nested 23 levels deep.
		doc := outputBudgetDoc(5000, 400, 0, 0)
		doc["proof"] = proofChains(25, 20)
		if d := jsonDepth(doc); d > admissionDepthBudget {
			t.Fatalf("fixture is %d levels deep, over the depth budget of %d", d, admissionDepthBudget)
		}
		if err := CheckCanonicalizable(copyJSON(t, doc)); err != nil {
			t.Fatalf("fixture fails the JSON pre-check: %v", err)
		}
		if s := measureDataset(t, doc, loader); s.blankNodes <= datasetBlankNodeBudget {
			t.Fatalf("fixture has %d blank nodes, want more than %d", s.blankNodes, datasetBlankNodeBudget)
		}
		if e := measureOutputEstimate(t, doc, loader); e <= datasetOutputBudget {
			t.Fatalf("fixture is estimated at %d bytes, want more than %d", e, datasetOutputBudget)
		}
		got, err := Canonicalize(copyJSON(t, doc), loader)
		wantAdmissionRefusal(t, got, err, RuleBlankNodeBudget)
	})

	t.Run("over the output budget with indistinguishable blank nodes reports output-budget", func(t *testing.T) {
		doc := outputBudgetDoc(1500, 600, 0, 0)
		doc["credentialSubject"] = []any{map[string]any{}, map[string]any{}}
		if err := CheckCanonicalizable(copyJSON(t, doc)); err != nil {
			t.Fatalf("fixture fails the JSON pre-check: %v", err)
		}
		s := measureDataset(t, doc, loader)
		if len(s.duplicates) == 0 {
			t.Fatalf("fixture has no indistinguishable blank nodes")
		}
		if s.blankNodes > datasetBlankNodeBudget {
			t.Fatalf("fixture has %d blank nodes, over the budget of %d", s.blankNodes, datasetBlankNodeBudget)
		}
		if e := measureOutputEstimate(t, doc, loader); e <= datasetOutputBudget {
			t.Fatalf("fixture is estimated at %d bytes, want more than %d", e, datasetOutputBudget)
		}
		got, err := Canonicalize(copyJSON(t, doc), loader)
		wantAdmissionRefusal(t, got, err, RuleOutputBudget)
	})
}

// outputBudgetAllocCeiling bounds what refusing the far-over-budget document
// below may allocate. On that document json-gold's expansion was measured at
// under twice the budget, and serializing every line to estimate it at over
// five hundred times; the estimate stops being worth computing once the
// running sum passes the budget, and each line serialized until then is
// copied a few times as json-gold builds it. Thirty-two times the budget
// covers that with room to spare while failing any refusal that serializes
// most of the dataset.
const outputBudgetAllocCeiling = 32 * datasetOutputBudget

// The output budget exists because serializing the dataset is itself the
// cost it bounds, so the refusal must not pay it: a document estimated at
// many times the budget is refused having allocated a small multiple of the
// budget, not of the estimate.
func TestCanonicalize_OutputBudgetRefusalStopsEarly(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	doc := outputBudgetDoc(40000, 1000, 0, 0)
	if err := CheckCanonicalizable(copyJSON(t, doc)); err != nil {
		t.Fatalf("fixture fails the JSON pre-check: %v", err)
	}
	estimate := measureOutputEstimate(t, doc, loader)
	if estimate < 50*datasetOutputBudget {
		t.Fatalf("fixture is estimated at %d bytes, want at least 50 times the budget (%d)", estimate, 50*datasetOutputBudget)
	}

	input := copyJSON(t, doc)
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	got, err := Canonicalize(input, loader)
	runtime.ReadMemStats(&after)
	allocated := after.TotalAlloc - before.TotalAlloc
	t.Logf("estimate %d bytes (%.1fx the budget); Canonicalize allocated %d bytes (%.1fx the budget)",
		estimate, float64(estimate)/datasetOutputBudget, allocated, float64(allocated)/datasetOutputBudget)

	wantAdmissionRefusal(t, got, err, RuleOutputBudget)
	if allocated >= outputBudgetAllocCeiling {
		t.Errorf("Canonicalize allocated %d bytes refusing the document, want < %d", allocated, outputBudgetAllocCeiling)
	}
}
