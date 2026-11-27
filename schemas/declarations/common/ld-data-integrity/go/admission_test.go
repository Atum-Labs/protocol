package lddataintegrity

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// admissionVector mirrors one entry of conformance/admission-vectors.json.
// Rule and Path are pointers because the file uses null to mean "not
// asserted": a null rule marks a document violating several rules (rule
// order is unspecified), a null path marks one rule violated at several
// locations (which location is reported is unspecified).
//
// The remaining fields are an accept vector's expected canonical output,
// shared by every implementation: Nquads verbatim, or NquadsSHA256 and
// NquadsLength when the output is too long to carry, or KnownDivergence, the
// reason a vector has no expected output.
type admissionVector struct {
	Name string  `json:"name"`
	Rule *string `json:"rule"`
	Path *string `json:"path"`
	Doc  any     `json:"doc"`

	Nquads          *string `json:"nquads"`
	NquadsSHA256    *string `json:"nquads_sha256"`
	NquadsLength    *int    `json:"nquads_length"`
	KnownDivergence *string `json:"known_divergence"`
}

// generatedAdmissionVector is a template entry of the file's generated
// section: Doc is expanded by expandAdmissionTemplate, and Bytes is the
// byte count the expanded document must have.
type generatedAdmissionVector struct {
	admissionVector
	Bytes int `json:"bytes"`
}

type admissionVectorFile struct {
	Accept    []admissionVector `json:"accept"`
	Refuse    []admissionVector `json:"refuse"`
	Generated struct {
		Accept []generatedAdmissionVector `json:"accept"`
		Refuse []generatedAdmissionVector `json:"refuse"`
	} `json:"generated"`
}

// admissionBudgetBytes mirrors the contract's byte budget (128 KiB of
// string values plus object keys). It is restated here, not imported, so
// the fixture guard checks the file against the contract rather than
// against whatever the implementation happens to use.
const admissionBudgetBytes = 128 * 1024

// The vector file is intended to be shared with the TypeScript
// implementation, so it lives beside the language directories rather than
// under go/.
func admissionVectorsPath(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("cwd: %v", err)
	}
	return filepath.Join(cwd, "..", "conformance", "admission-vectors.json")
}

func loadAdmissionVectors(t *testing.T) admissionVectorFile {
	t.Helper()
	raw, err := os.ReadFile(admissionVectorsPath(t))
	if err != nil {
		t.Fatalf("read admission vectors: %v", err)
	}
	var f admissionVectorFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse admission vectors: %v", err)
	}
	if len(f.Accept) == 0 || len(f.Refuse) == 0 {
		t.Fatalf("admission vectors: %d accept, %d refuse; want both non-empty", len(f.Accept), len(f.Refuse))
	}
	if len(f.Generated.Accept) == 0 || len(f.Generated.Refuse) == 0 {
		t.Fatalf("admission vectors: %d generated accept, %d generated refuse; want both non-empty", len(f.Generated.Accept), len(f.Generated.Refuse))
	}
	// Expanded vectors join the literal lists so every accept/refuse test
	// exercises them exactly as it does the literal ones.
	for _, list := range []*[]generatedAdmissionVector{&f.Generated.Accept, &f.Generated.Refuse} {
		for i := range *list {
			g := &(*list)[i]
			doc, err := expandAdmissionTemplate(g.Doc)
			if err != nil {
				t.Fatalf("generated %q: %v", g.Name, err)
			}
			g.Doc = doc
		}
	}
	for _, g := range f.Generated.Accept {
		f.Accept = append(f.Accept, g.admissionVector)
	}
	for _, g := range f.Generated.Refuse {
		f.Refuse = append(f.Refuse, g.admissionVector)
	}
	return f
}

// expandAdmissionTemplate implements the template grammar stated in the
// vector file's _comment, and nothing more. It is deliberately strict (exact
// key sets, integer counts, no literal "$" keys) so a malformed template is a
// fixture error instead of silently becoming a small literal document that
// proves nothing about the byte budget.
func expandAdmissionTemplate(v any) (any, error) {
	switch x := v.(type) {
	case map[string]any:
		if s, ok := x["$repeat"]; ok {
			n, nok := x["$times"].(float64)
			str, sok := s.(string)
			if len(x) != 2 || !sok || !nok || n < 0 || n != float64(int(n)) {
				return nil, fmt.Errorf("malformed $repeat template %v", x)
			}
			return strings.Repeat(str, int(n)), nil
		}
		if pairs, ok := x["$object"]; ok {
			list, lok := pairs.([]any)
			if len(x) != 1 || !lok {
				return nil, fmt.Errorf("malformed $object template %v", x)
			}
			out := make(map[string]any, len(list))
			for _, p := range list {
				kv, ok := p.([]any)
				if !ok || len(kv) != 2 {
					return nil, fmt.Errorf("$object member %v is not a [key, value] pair", p)
				}
				ek, err := expandAdmissionTemplate(kv[0])
				if err != nil {
					return nil, err
				}
				k, ok := ek.(string)
				if !ok {
					return nil, fmt.Errorf("$object key %v does not expand to a string", kv[0])
				}
				if _, dup := out[k]; dup {
					return nil, fmt.Errorf("duplicate $object key of %d bytes", len(k))
				}
				ev, err := expandAdmissionTemplate(kv[1])
				if err != nil {
					return nil, err
				}
				out[k] = ev
			}
			return out, nil
		}
		out := make(map[string]any, len(x))
		for k, c := range x {
			if strings.HasPrefix(k, "$") {
				return nil, fmt.Errorf("literal object key %q begins with \"$\", which the grammar reserves", k)
			}
			ec, err := expandAdmissionTemplate(c)
			if err != nil {
				return nil, err
			}
			out[k] = ec
		}
		return out, nil
	case []any:
		out := make([]any, len(x))
		for i, c := range x {
			ec, err := expandAdmissionTemplate(c)
			if err != nil {
				return nil, err
			}
			out[i] = ec
		}
		return out, nil
	}
	return v, nil
}

// The expander is the Go reading of a grammar a second implementation is
// meant to share, so each edge case the file's _comment names is pinned
// here: every form it calls a fixture error must be rejected, and every
// form it allows must expand exactly as described.
func TestExpandAdmissionTemplate_FollowsTheDocumentedGrammar(t *testing.T) {
	parse := func(t *testing.T, src string) any {
		t.Helper()
		var v any
		if err := json.Unmarshal([]byte(src), &v); err != nil {
			t.Fatalf("parse %s: %v", src, err)
		}
		return v
	}
	valid := []struct{ name, src, want string }{
		{"repeat", `{"$repeat":"ab","$times":3}`, `"ababab"`},
		{"repeat zero times", `{"$repeat":"ab","$times":0}`, `""`},
		{"repeat count written with an exponent is still an integer", `{"$repeat":"a","$times":2e0}`, `"aa"`},
		{"repeat nested in literal object and array", `{"a":[{"$repeat":"x","$times":2}],"b":1}`, `{"a":["xx"],"b":1}`},
		{"object with a templated key and value", `{"$object":[[{"$repeat":"k","$times":2},{"$repeat":"v","$times":2}]]}`, `{"kk":"vv"}`},
		{"empty object template", `{"$object":[]}`, `{}`},
		{"object template may produce a key beginning with $", `{"$object":[["$x",1]]}`, `{"$x":1}`},
		{"scalars unchanged", `[null,true,1.5,"$repeat"]`, `[null,true,1.5,"$repeat"]`},
	}
	for _, c := range valid {
		t.Run("expands/"+c.name, func(t *testing.T) {
			got, err := expandAdmissionTemplate(parse(t, c.src))
			if err != nil {
				t.Fatalf("expandAdmissionTemplate(%s) = %v, want %s", c.src, err, c.want)
			}
			if want := parse(t, c.want); !reflect.DeepEqual(got, want) {
				t.Errorf("expandAdmissionTemplate(%s) = %#v, want %#v", c.src, got, want)
			}
		})
	}
	invalid := []struct{ name, src string }{
		{"repeat without times", `{"$repeat":"x"}`},
		{"repeat with an extra key", `{"$repeat":"x","$times":1,"a":1}`},
		{"repeat with a non-string s", `{"$repeat":1,"$times":1}`},
		{"repeat with a template as s", `{"$repeat":{"$repeat":"x","$times":1},"$times":1}`},
		{"repeat with a negative count", `{"$repeat":"x","$times":-1}`},
		{"repeat with a fractional count", `{"$repeat":"x","$times":1.5}`},
		{"repeat with a string count", `{"$repeat":"x","$times":"1"}`},
		{"repeat and object keys together", `{"$repeat":"x","$times":1,"$object":[]}`},
		{"object with an extra key", `{"$object":[],"a":1}`},
		{"object whose value is not an array", `{"$object":{"a":1}}`},
		{"object pair that is not an array", `{"$object":["a"]}`},
		{"object pair with one element", `{"$object":[["a"]]}`},
		{"object pair with three elements", `{"$object":[["a",1,2]]}`},
		{"object key that is not a string", `{"$object":[[1,1]]}`},
		{"object key that expands to a non-string", `{"$object":[[{"$object":[]},1]]}`},
		{"duplicate literal object keys", `{"$object":[["a",1],["a",2]]}`},
		{"duplicate expanded object keys", `{"$object":[[{"$repeat":"a","$times":2},1],["aa",2]]}`},
		{"literal key beginning with $", `{"$times":1}`},
		{"literal key beginning with $ nested in an array", `[{"a":{"$x":1}}]`},
		{"malformed template nested in an object value", `{"a":{"$repeat":"x"}}`},
		{"malformed template nested in an object pair value", `{"$object":[["a",{"$repeat":"x"}]]}`},
	}
	for _, c := range invalid {
		t.Run("rejects/"+c.name, func(t *testing.T) {
			if got, err := expandAdmissionTemplate(parse(t, c.src)); err == nil {
				t.Errorf("expandAdmissionTemplate(%s) = %#v, nil; want a fixture error", c.src, got)
			}
		})
	}
}

func findAdmissionVector(t *testing.T, list []admissionVector, prefix string) admissionVector {
	t.Helper()
	for _, v := range list {
		if strings.HasPrefix(v.Name, prefix) {
			return v
		}
	}
	t.Fatalf("no admission vector named %q...", prefix)
	return admissionVector{}
}

// countJSONValues is the test's own oracle for the budget unit: every
// object, array and scalar is one value, the root included, keys excluded.
// It exists only to prove the boundary vectors sit where their names say.
func countJSONValues(v any) int {
	n := 1
	switch x := v.(type) {
	case map[string]any:
		for _, c := range x {
			n += countJSONValues(c)
		}
	case []any:
		for _, c := range x {
			n += countJSONValues(c)
		}
	}
	return n
}

// countJSONBytes is the test's own oracle for the byte-budget unit: the
// UTF-8 length of every string value and every object key, at any depth.
// Go strings decoded by encoding/json are UTF-8, so len is the byte count.
func countJSONBytes(v any) int {
	switch x := v.(type) {
	case string:
		return len(x)
	case map[string]any:
		n := 0
		for k, c := range x {
			n += len(k) + countJSONBytes(c)
		}
		return n
	case []any:
		n := 0
		for _, c := range x {
			n += countJSONBytes(c)
		}
		return n
	}
	return 0
}

// admissionDepthBudget mirrors the contract's depth budget: the root object
// or array is at depth 1, and no object or array may sit deeper than this.
// Restated rather than imported, like admissionBudgetBytes.
const admissionDepthBudget = 32

// jsonDepth is the test's own oracle for the depth unit: the root object or
// array is at depth 1, each nested object or array one deeper, and scalars
// add nothing, so a scalar document has depth 0.
func jsonDepth(v any) int {
	deepest := 0
	switch x := v.(type) {
	case map[string]any:
		for _, c := range x {
			deepest = max(deepest, jsonDepth(c))
		}
	case []any:
		for _, c := range x {
			deepest = max(deepest, jsonDepth(c))
		}
	default:
		return 0
	}
	return 1 + deepest
}

// The wire strings of the depth and tab rules, restated rather than taken
// from exported constants so that the tests pin the spelling the contract
// and the vector file use.
const (
	ruleDepthBudget  AdmissionRule = "depth-budget"
	ruleTabCharacter AdmissionRule = "tab-character"
)

var allAdmissionRules = []AdmissionRule{
	RuleValueBudget,
	RuleByteBudget,
	RuleReservedKey,
	RuleCompactIRIKey,
	RuleContextShape,
	RuleBlankNodeLabel,
	ruleDepthBudget,
	ruleTabCharacter,
}

// codeOnlyAdmissionRules are rules CheckCanonicalizable reports that no
// shared vector can exercise in Go, because encoding/json repairs the input
// they refuse while decoding. They are kept apart from allAdmissionRules,
// whose file guard requires a refuse vector for every rule it lists, and
// their documents are built in code.
var codeOnlyAdmissionRules = []AdmissionRule{
	RuleIllFormedString,
}

// The rule ids are a cross-language wire vocabulary (the vector file
// compares against these strings, and so would any port reading it), so
// their spelling is part of the contract, not an implementation detail.
func TestAdmissionRule_IDsAreTheWireStrings(t *testing.T) {
	want := map[AdmissionRule]string{
		RuleValueBudget:     "value-budget",
		RuleByteBudget:      "byte-budget",
		RuleReservedKey:     "reserved-key",
		RuleCompactIRIKey:   "compact-iri-key",
		RuleContextShape:    "context-shape",
		RuleBlankNodeLabel:  "blank-node-label",
		RuleIllFormedString: "ill-formed-string",
		ruleDepthBudget:     "depth-budget",
		ruleTabCharacter:    "tab-character",
	}
	if n := len(allAdmissionRules) + len(codeOnlyAdmissionRules); len(want) != n {
		t.Fatalf("rule constants are not pairwise distinct: %d distinct of %d", len(want), n)
	}
	for r, s := range want {
		if string(r) != s {
			t.Errorf("rule constant = %q, want %q", string(r), s)
		}
	}
}

func TestAdmissionError_IsErrNotCanonicalizable(t *testing.T) {
	if ErrNotCanonicalizable == nil {
		t.Fatal("ErrNotCanonicalizable is nil")
	}
	for _, r := range append(append([]AdmissionRule{}, allAdmissionRules...), codeOnlyAdmissionRules...) {
		var err error = &AdmissionError{Rule: r, Path: "/a"}
		if !errors.Is(err, ErrNotCanonicalizable) {
			t.Errorf("errors.Is(&AdmissionError{Rule: %q}, ErrNotCanonicalizable) = false, want true", r)
		}
		wrapped := fmt.Errorf("outer: %w", err)
		if !errors.Is(wrapped, ErrNotCanonicalizable) {
			t.Errorf("errors.Is(wrapped &AdmissionError{Rule: %q}, ErrNotCanonicalizable) = false, want true", r)
		}
		var ae *AdmissionError
		if !errors.As(wrapped, &ae) || ae.Rule != r || ae.Path != "/a" {
			t.Errorf("errors.As(wrapped, *AdmissionError) = %v (%+v), want Rule %q Path %q", ae != nil, ae, r, "/a")
		}
	}
}

// A document-wide refusal has no location, so a message like `... at ""`
// would point the reader at a place that does not exist; a located refusal
// must name its location so the caller can find the offending member.
func TestAdmissionError_ErrorNamesALocationOnlyWhenThereIsOne(t *testing.T) {
	for _, r := range []AdmissionRule{RuleValueBudget, RuleByteBudget} {
		msg := (&AdmissionError{Rule: r, Path: ""}).Error()
		if strings.Contains(msg, " at ") {
			t.Errorf("(&AdmissionError{Rule: %q, Path: \"\"}).Error() = %q, want no \" at \"", r, msg)
		}
	}
	const path = "/a~1b/0/c"
	for _, r := range append(append([]AdmissionRule{}, allAdmissionRules...), codeOnlyAdmissionRules...) {
		msg := (&AdmissionError{Rule: r, Path: path}).Error()
		if !strings.Contains(msg, path) {
			t.Errorf("(&AdmissionError{Rule: %q, Path: %q}).Error() = %q, want it to contain the path", r, path, msg)
		}
	}
}

// Guards the vector file itself: every rule has an exact vector, nulls are
// only used where the file's comment allows, the value-budget boundary
// vectors really hold 1024 and 1025 values, and every generated vector
// really holds the byte count it declares while staying far inside the
// value budget (so a byte-budget refusal cannot be a value-budget one in
// disguise). Without this a fixture edit could silently drop a rule's
// coverage or move a boundary.
func TestAdmissionVectors_FileCoversEveryRuleAndTheBudgetBoundary(t *testing.T) {
	f := loadAdmissionVectors(t)
	known := map[string]bool{}
	for _, r := range allAdmissionRules {
		known[string(r)] = false
	}
	for _, v := range f.Refuse {
		if v.Rule == nil {
			if v.Path != nil {
				t.Errorf("refuse %q: path %q set with null rule; a path is only meaningful for a named rule", v.Name, *v.Path)
			}
			continue
		}
		seen, ok := known[*v.Rule]
		if !ok {
			t.Errorf("refuse %q: unknown rule id %q", v.Name, *v.Rule)
			continue
		}
		if v.Path != nil && !seen {
			known[*v.Rule] = true
		}
	}
	for r, covered := range known {
		if !covered {
			t.Errorf("no refuse vector asserts rule %q with an exact path", r)
		}
	}

	at := findAdmissionVector(t, f.Accept, "value budget boundary: exactly 1024 values")
	if n := countJSONValues(at.Doc); n != 1024 {
		t.Errorf("accept %q holds %d values, want 1024", at.Name, n)
	}
	over := findAdmissionVector(t, f.Refuse, "value budget boundary: 1025 values")
	if n := countJSONValues(over.Doc); n != 1025 {
		t.Errorf("refuse %q holds %d values, want 1025", over.Name, n)
	}

	var acceptAtBudget, refuseOverBudget bool
	for _, g := range f.Generated.Accept {
		if g.Bytes > admissionBudgetBytes {
			t.Errorf("generated accept %q declares %d bytes, over the %d budget", g.Name, g.Bytes, admissionBudgetBytes)
		}
		acceptAtBudget = acceptAtBudget || g.Bytes == admissionBudgetBytes
	}
	for _, g := range f.Generated.Refuse {
		if g.Bytes <= admissionBudgetBytes {
			t.Errorf("generated refuse %q declares %d bytes, within the %d budget", g.Name, g.Bytes, admissionBudgetBytes)
		}
		refuseOverBudget = refuseOverBudget || g.Bytes == admissionBudgetBytes+1
	}
	if !acceptAtBudget || !refuseOverBudget {
		t.Errorf("generated vectors: accept at exactly %d bytes present = %v, refuse at exactly %d present = %v; want both", admissionBudgetBytes, acceptAtBudget, admissionBudgetBytes+1, refuseOverBudget)
	}
	for _, list := range [][]generatedAdmissionVector{f.Generated.Accept, f.Generated.Refuse} {
		for _, g := range list {
			if n := countJSONBytes(g.Doc); n != g.Bytes {
				t.Errorf("generated %q expands to %d bytes, declares %d", g.Name, n, g.Bytes)
			}
			if n := countJSONValues(g.Doc); n > 64 {
				t.Errorf("generated %q holds %d values; byte-budget vectors must stay far below the value budget", g.Name, n)
			}
		}
	}
	// Keys count toward the budget: at least one refusal must come mostly
	// from a single key, or a check counting only values would pass.
	var keyHeavy bool
	for _, g := range f.Generated.Refuse {
		if m, ok := g.Doc.(map[string]any); ok {
			for k := range m {
				keyHeavy = keyHeavy || 2*len(k) > g.Bytes
			}
		}
	}
	if !keyHeavy {
		t.Error("no generated refuse vector takes most of its bytes from one object key")
	}

	// @context is exempt from no budget. Each @context vector must hold its
	// declared count and take most of its weight from @context, so an
	// implementation that skipped @context (or only its key) would flip the
	// refusal to an admission; its strings must break no other rule, so the
	// refusal can only be the budget's.
	contextOnlyBudget := func(name string, doc any) map[string]any {
		t.Helper()
		m, ok := doc.(map[string]any)
		if !ok {
			t.Fatalf("%q: doc is %T, want an object", name, doc)
		}
		ctx, ok := m["@context"].([]any)
		if !ok {
			t.Fatalf("%q: @context is %T, want an array of strings", name, m["@context"])
		}
		for i, e := range ctx {
			s, ok := e.(string)
			if !ok || strings.HasPrefix(s, "_:") {
				t.Errorf("%q: @context[%d] = %v, want a string not beginning with \"_:\"", name, i, e)
			}
		}
		return m
	}
	for _, c := range []struct {
		list []admissionVector
		want int
	}{
		{f.Accept, 1024},
		{f.Refuse, 1025},
	} {
		v := findAdmissionVector(t, c.list, "value budget: @context counts")
		m := contextOnlyBudget(v.Name, v.Doc)
		if n := countJSONValues(v.Doc); n != c.want {
			t.Errorf("%q holds %d values, want %d", v.Name, n, c.want)
		}
		if n := 1 + countJSONValues(m["@context"]); 2*n <= c.want {
			t.Errorf("%q: @context holds %d of %d values, want most of them", v.Name, n, c.want)
		}
		if n := countJSONBytes(v.Doc); n > admissionBudgetBytes/2 {
			t.Errorf("%q holds %d bytes; a value-budget vector must stay far below the byte budget", v.Name, n)
		}
	}
	for _, c := range []struct {
		list []generatedAdmissionVector
		want int
	}{
		{f.Generated.Accept, admissionBudgetBytes},
		{f.Generated.Refuse, admissionBudgetBytes + 1},
	} {
		var g *generatedAdmissionVector
		for i := range c.list {
			if strings.HasPrefix(c.list[i].Name, "byte budget: @context counts") {
				g = &c.list[i]
				break
			}
		}
		if g == nil {
			t.Errorf("no generated vector named %q... declaring %d bytes", "byte budget: @context counts", c.want)
			continue
		}
		m := contextOnlyBudget(g.Name, g.Doc)
		if g.Bytes != c.want {
			t.Errorf("%q declares %d bytes, want %d", g.Name, g.Bytes, c.want)
		}
		if n := len("@context") + countJSONBytes(m["@context"]); 2*n <= g.Bytes {
			t.Errorf("%q: @context contributes %d of %d bytes, want most of them", g.Name, n, g.Bytes)
		}
	}

	// The key-order vector only discriminates if its two keys sort
	// differently by code point and by UTF-16 code unit.
	ko := findAdmissionVector(t, f.Refuse, "key order is code point order")
	m, ok := ko.Doc.(map[string]any)
	if !ok || len(m) != 2 || ko.Path == nil {
		t.Fatalf("key-order vector: doc %T with %d keys, path %v; want a two-key object and an exact path", ko.Doc, len(m), ko.Path)
	}
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	a, b := keys[0], keys[1]
	if (a < b) == utf16Less(a, b) {
		t.Errorf("key-order vector keys %q and %q sort the same by code point and by UTF-16 code unit; the vector discriminates nothing", a, b)
	}
	first := a
	if b < a {
		first = b
	}
	if want := "/" + first; *ko.Path != want {
		t.Errorf("key-order vector path = %q, want the code-point-first key %q", *ko.Path, want)
	}
}

// utf16Less is JavaScript's default string comparison, the order an
// implementation would get from a plain Array.prototype.sort of keys.
func utf16Less(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}

func TestCheckCanonicalizable_AcceptVectorsAreAdmitted(t *testing.T) {
	for _, v := range loadAdmissionVectors(t).Accept {
		t.Run(v.Name, func(t *testing.T) {
			if err := CheckCanonicalizable(v.Doc); err != nil {
				t.Errorf("CheckCanonicalizable = %v, want nil", err)
			}
		})
	}
}

func TestCheckCanonicalizable_RefuseVectorsReportRuleAndPath(t *testing.T) {
	for _, v := range loadAdmissionVectors(t).Refuse {
		t.Run(v.Name, func(t *testing.T) {
			err := CheckCanonicalizable(v.Doc)
			if err == nil {
				t.Fatal("CheckCanonicalizable = nil, want refusal")
			}
			if !errors.Is(err, ErrNotCanonicalizable) {
				t.Errorf("errors.Is(err, ErrNotCanonicalizable) = false for %v", err)
			}
			var ae *AdmissionError
			if !errors.As(err, &ae) {
				t.Fatalf("err = %T %v, want *AdmissionError", err, err)
			}
			if v.Rule != nil && ae.Rule != AdmissionRule(*v.Rule) {
				t.Errorf("Rule = %q, want %q", ae.Rule, *v.Rule)
			}
			if v.Path != nil && ae.Path != *v.Path {
				t.Errorf("Path = %q, want %q", ae.Path, *v.Path)
			}
		})
	}
}

// Canonicalize must hand back the check's own verdict, not a re-wrapped or
// re-derived one. Only exact (single-violation, single-location) vectors
// are compared, because a multi-violation document may legitimately report
// a different rule on each call.
func TestCanonicalize_ReturnsTheAdmissionErrorUnchanged(t *testing.T) {
	loader := NewDocumentLoader(nil)
	for _, v := range loadAdmissionVectors(t).Refuse {
		if v.Rule == nil || v.Path == nil {
			continue
		}
		t.Run(v.Name, func(t *testing.T) {
			out, err := Canonicalize(v.Doc, loader)
			if err == nil {
				t.Fatalf("Canonicalize returned %d bytes of N-Quads and a nil error; want refusal", len(out))
			}
			if out != "" {
				t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
			}
			var ae *AdmissionError
			if !errors.As(err, &ae) {
				t.Fatalf("err = %T %v, want *AdmissionError", err, err)
			}
			if ae.Rule != AdmissionRule(*v.Rule) || ae.Path != *v.Path {
				t.Errorf("Canonicalize AdmissionError = {%q %q}, want {%q %q} as reported by CheckCanonicalizable", ae.Rule, ae.Path, *v.Rule, *v.Path)
			}
		})
	}
}

// The document names a @context URL the loader does not know. If json-gold
// ran, the loader would fail closed with ErrUnknownContext; getting the
// admission error instead, and no ErrUnknownContext anywhere in the chain,
// shows the check ran before any JSON-LD processing.
func TestCanonicalize_RefusesBeforeJSONLDProcessing(t *testing.T) {
	doc := map[string]any{
		"@context": "https://attacker.example/evil-context.jsonld",
		"a":        "_:b0",
	}
	_, err := Canonicalize(doc, NewDocumentLoader(nil))
	if !errors.Is(err, ErrNotCanonicalizable) {
		t.Fatalf("err = %v, want errors.Is ErrNotCanonicalizable", err)
	}
	if errors.Is(err, ErrUnknownContext) {
		t.Errorf("err = %v also carries ErrUnknownContext; the context was loaded before admission", err)
	}
	var ae *AdmissionError
	if !errors.As(err, &ae) || ae.Rule != RuleBlankNodeLabel || ae.Path != "/a" {
		t.Errorf("err = %v, want *AdmissionError{Rule: %q, Path: %q}", err, RuleBlankNodeLabel, "/a")
	}
}

func TestCanonicalize_AcceptVectorsAreNotRefusedByAdmission(t *testing.T) {
	loader := NewDocumentLoader(nil)
	for _, v := range loadAdmissionVectors(t).Accept {
		t.Run(v.Name, func(t *testing.T) {
			// Other failures (e.g. an unregistered @context URL) are
			// json-gold's concern and out of scope here.
			if _, err := Canonicalize(v.Doc, loader); errors.Is(err, ErrNotCanonicalizable) {
				t.Errorf("Canonicalize refused an admitted document: %v", err)
			}
		})
	}
}

// Unguarded, json-gold spends seconds canonicalizing the clique, so a
// 100 ms ceiling can only be met if the refusal happens before json-gold is
// invoked. The clique names no @context, so the loader plays no part and
// cannot make json-gold fail fast on its own. This proves only that this one
// vector is refused before JSON-LD processing; it says nothing about how
// long an admitted document takes to canonicalize.
func TestCanonicalize_RefusesTheCliqueVectorBeforeJSONLDWithin100ms(t *testing.T) {
	v := findAdmissionVector(t, loadAdmissionVectors(t).Refuse, "clique:")
	start := time.Now()
	_, err := Canonicalize(v.Doc, NewDocumentLoader(nil))
	elapsed := time.Since(start)
	if elapsed >= 100*time.Millisecond {
		t.Errorf("Canonicalize took %v, want < 100ms", elapsed)
	}
	var ae *AdmissionError
	if !errors.As(err, &ae) {
		t.Errorf("err = %T %v, want *AdmissionError", err, err)
	}
}

// A linear walk over 1024 values is a few microseconds to a few tens of
// microseconds on current hardware. A 1 ms average is roughly two orders
// of magnitude of headroom, which absorbs the race detector and a loaded
// CI runner, while still failing a gross slowdown of the walk.
func TestCheckCanonicalizable_BudgetSizedDocumentAveragesUnder1ms(t *testing.T) {
	v := findAdmissionVector(t, loadAdmissionVectors(t).Accept, "value budget boundary: exactly 1024 values")
	const runs = 200
	start := time.Now()
	for i := 0; i < runs; i++ {
		if err := CheckCanonicalizable(v.Doc); err != nil {
			t.Fatalf("CheckCanonicalizable = %v, want nil", err)
		}
	}
	if avg := time.Since(start) / runs; avg >= time.Millisecond {
		t.Errorf("CheckCanonicalizable averaged %v over %d runs on a 1024-value document, want < 1ms", avg, runs)
	}
}

func TestCheckCanonicalizable_DoesNotMutateInput(t *testing.T) {
	f := loadAdmissionVectors(t)
	for _, v := range []admissionVector{
		findAdmissionVector(t, f.Accept, "verifiable presentation embedding"),
		findAdmissionVector(t, f.Refuse, "clique:"),
		findAdmissionVector(t, f.Refuse, "byte budget: nested strings and keys count at every depth"),
	} {
		t.Run(v.Name, func(t *testing.T) {
			raw, err := json.Marshal(v.Doc)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var before any
			if err := json.Unmarshal(raw, &before); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			_ = CheckCanonicalizable(v.Doc)
			if !reflect.DeepEqual(before, v.Doc) {
				t.Errorf("CheckCanonicalizable mutated its input")
			}
		})
	}
}

// Admission must be invisible to every document the protocol already
// signs, or their canonical bytes (and every golden hash) would break. The
// corpus is every JSON-LD document (any object carrying "@context"; nested
// ones are covered by checking their outermost carrier) found in each
// schema's conformance tree, its Go bindings' testdata, and its example.
func TestCheckCanonicalizable_AdmitsExistingProtocolDocuments(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("cwd: %v", err)
	}
	declarations, err := filepath.Abs(filepath.Join(cwd, "..", "..", ".."))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}

	var files []string
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
		files = append(files, path)
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", declarations, err)
	}

	docs := 0
	for _, path := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		rel, _ := filepath.Rel(declarations, path)
		forEachJSONLDDocument(v, "", func(ptr string, doc map[string]any) {
			docs++
			if err := CheckCanonicalizable(doc); err != nil {
				t.Errorf("%s#%s: CheckCanonicalizable = %v, want nil", rel, ptr, err)
			}
		})
	}
	// A broken walk would otherwise pass vacuously; the tree holds over 20.
	if docs < 10 {
		t.Fatalf("found %d JSON-LD documents in %d files under %s, want at least 10", docs, len(files), declarations)
	}
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// forEachJSONLDDocument reports each outermost object carrying "@context"
// and does not descend into it, so an embedded credential is checked as
// part of its presentation exactly as it would be canonicalized.
func forEachJSONLDDocument(v any, ptr string, fn func(string, map[string]any)) {
	switch x := v.(type) {
	case map[string]any:
		if _, ok := x["@context"]; ok {
			fn(ptr, x)
			return
		}
		for k, c := range x {
			esc := strings.ReplaceAll(strings.ReplaceAll(k, "~", "~0"), "/", "~1")
			forEachJSONLDDocument(c, ptr+"/"+esc, fn)
		}
	case []any:
		for i, c := range x {
			forEachJSONLDDocument(c, fmt.Sprintf("%s/%d", ptr, i), fn)
		}
	}
}

// holdsInvalidUTF8 is the fixture guard for the ill-formed-string tests:
// whether any key or string value in v, at any depth, is not valid UTF-8.
func holdsInvalidUTF8(v any) bool {
	switch x := v.(type) {
	case string:
		return !utf8.ValidString(x)
	case map[string]any:
		for k, c := range x {
			if !utf8.ValidString(k) || holdsInvalidUTF8(c) {
				return true
			}
		}
	case []any:
		for _, c := range x {
			if holdsInvalidUTF8(c) {
				return true
			}
		}
	}
	return false
}

// illFormedStringCase is a document built in code, because JSON text cannot
// carry invalid UTF-8 to CheckCanonicalizable: encoding/json replaces it,
// and a lone surrogate escape, with U+FFFD while decoding. Paths hold the
// offending key's raw bytes, escaped per RFC 6901 like any other key.
type illFormedStringCase struct {
	name string
	doc  any
	rule AdmissionRule
	path string
}

func illFormedStringRefusals() []illFormedStringCase {
	r := RuleIllFormedString
	return []illFormedStringCase{
		{"stray continuation byte in a root key", map[string]any{"a\xffb": 1.0}, r, "/a\xffb"},
		{"lone lead byte in a nested key", map[string]any{"a": map[string]any{"b\xc0": 1.0}}, r, "/a/b\xc0"},
		{"invalid key inside an array element", map[string]any{"a": []any{map[string]any{"k\xff": 1.0}}}, r, "/a/0/k\xff"},
		{"invalid key needing JSON Pointer escaping", map[string]any{"a/b~\xff": 1.0}, r, "/a~1b~0\xff"},
		{"invalid key whose value is empty", map[string]any{"\xff": ""}, r, "/\xff"},
		{"surrogate code point U+D800 encoded in a string value", map[string]any{"a": "\xed\xa0\x80"}, r, "/a"},
		{"surrogate code point U+DFFF encoded at the end of an array element", map[string]any{"a": []any{1.0, "ok", "x\xed\xbf\xbf"}}, r, "/a/2"},
		{"truncated three-byte sequence in a nested value", map[string]any{"a": map[string]any{"b": "\xe2\x82"}}, r, "/a/b"},
		{"overlong encoding of a slash", map[string]any{"a": "\xc0\xaf"}, r, "/a"},
		{"code point above U+10FFFF", map[string]any{"a": "\xf4\x90\x80\x80"}, r, "/a"},
		{"invalid byte after a valid multi-byte character", map[string]any{"a": "\xf0\x9f\x98\x80\xff"}, r, "/a"},
		{"invalid @context string", map[string]any{"@context": "https://www.w3.org/2018/credentials/v1\xff"}, r, "/@context"},
		{"invalid string in an @context array", map[string]any{"@context": []any{"https://www.w3.org/2018/credentials/v1", "\xff"}}, r, "/@context/1"},
		{"invalid string as the whole document", "\xff", r, ""},
		{"invalid string inside a root array", []any{map[string]any{"a": 1.0}, "\xff"}, r, "/1"},
	}
}

func wantCheckRefusal(t *testing.T, err error, rule AdmissionRule, path string) {
	t.Helper()
	if err == nil {
		t.Fatal("CheckCanonicalizable = nil, want refusal")
	}
	if !errors.Is(err, ErrNotCanonicalizable) {
		t.Errorf("errors.Is(err, ErrNotCanonicalizable) = false for %v", err)
	}
	var ae *AdmissionError
	if !errors.As(err, &ae) {
		t.Fatalf("err = %T %v, want *AdmissionError", err, err)
	}
	if ae.Rule != rule || ae.Path != path {
		t.Errorf("AdmissionError = {%q %q}, want {%q %q}", ae.Rule, ae.Path, rule, path)
	}
}

func TestCheckCanonicalizable_RefusesIllFormedStrings(t *testing.T) {
	for _, c := range illFormedStringRefusals() {
		t.Run(c.name, func(t *testing.T) {
			if !holdsInvalidUTF8(c.doc) {
				t.Fatal("fixture must hold invalid UTF-8")
			}
			wantCheckRefusal(t, CheckCanonicalizable(c.doc), c.rule, c.path)
		})
	}
}

// Valid multi-byte text must not be mistaken for invalid UTF-8. U+FFFD is
// what the decoder leaves where it repaired input, and TypeScript admits it,
// so refusing it would make the two languages disagree on a document both
// can observe.
func TestCheckCanonicalizable_AdmitsValidMultiByteUTF8(t *testing.T) {
	for _, c := range []struct {
		name string
		doc  any
	}{
		{"two-, three- and four-byte characters in a key and a value", map[string]any{"é日😀": "é日😀"}},
		{"replacement character U+FFFD in a key and a value", map[string]any{"\xef\xbf\xbd": "\xef\xbf\xbd"}},
		{"highest code point U+10FFFF as an array element", map[string]any{"a": []any{"\xf4\x8f\xbf\xbf"}}},
		{"lowest supplementary code point U+10000 as a key", map[string]any{"\xf0\x90\x80\x80": 1.0}},
		{"code points just outside the surrogate range", map[string]any{"\xed\x9f\xbf": "\xee\x80\x80"}},
		{"multi-byte text in a nested value", map[string]any{"a": map[string]any{"b": []any{"x😀y"}}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if holdsInvalidUTF8(c.doc) {
				t.Fatal("fixture must be valid UTF-8")
			}
			if err := CheckCanonicalizable(c.doc); err != nil {
				t.Errorf("CheckCanonicalizable = %v, want nil", err)
			}
		})
	}
}

// Precedence follows the walk, as in TypeScript: an object member's key
// bytes are counted, then the key is judged well-formed, then its syntax
// rules apply, then its value is walked; a string value's bytes are counted,
// then it is judged well-formed, then blank-node-label applies. The syntax
// rules come after well-formedness because they would otherwise interpret
// text that is not valid.
func TestCheckCanonicalizable_IllFormedStringPrecedence(t *testing.T) {
	zeros := make([]any, 1023)
	for i := range zeros {
		zeros[i] = 0.0
	}
	for _, c := range []illFormedStringCase{
		{"an ill-formed key is reported before a reserved-key violation in the same key", map[string]any{"@\xff": 1.0}, RuleIllFormedString, "/@\xff"},
		{"an ill-formed key is reported before a compact-iri-key violation in the same key", map[string]any{"a:\xff": 1.0}, RuleIllFormedString, "/a:\xff"},
		{"an ill-formed string value is reported before its blank-node-label violation", map[string]any{"a": "_:\xff"}, RuleIllFormedString, "/a"},
		{"an ill-formed key is reported before any violation in its value", map[string]any{"\xff": map[string]any{"@id": "_:b0"}}, RuleIllFormedString, "/\xff"},
		{"an inline @context object is refused by shape before its ill-formed contents are walked", map[string]any{"@context": map[string]any{"x": "\xff"}}, RuleContextShape, "/@context"},
		{"a reserved key is reported before the ill-formed string it holds", map[string]any{"@id": "\xff"}, RuleReservedKey, "/@id"},
		{"a compact IRI key is reported before the ill-formed string it holds", map[string]any{"ex:p": "\xff"}, RuleCompactIRIKey, "/ex:p"},
		{"an earlier sibling in code point order is reported first: ill-formed before blank-node-label", map[string]any{"b": "_:b0", "a": "\xff"}, RuleIllFormedString, "/a"},
		{"an earlier sibling in code point order is reported first: blank-node-label before ill-formed", map[string]any{"b": "\xff", "a": "_:b0"}, RuleBlankNodeLabel, "/a"},
		{"an earlier array element is reported first", map[string]any{"a": []any{"_:b0", "\xff"}}, RuleBlankNodeLabel, "/a/0"},
		// The ASCII run alone exceeds the budget, so these hold whatever
		// width the invalid byte is counted at.
		{"the byte budget is counted before an ill-formed string value is judged", map[string]any{"a": strings.Repeat("x", admissionBudgetBytes+1) + "\xff"}, RuleByteBudget, ""},
		{"the byte budget is counted before an ill-formed key is judged", map[string]any{strings.Repeat("k", admissionBudgetBytes+1) + "\xff": 1.0}, RuleByteBudget, ""},
		{"the value budget is reached before a later ill-formed string", map[string]any{"a": zeros, "b": "\xff"}, RuleValueBudget, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			if !holdsInvalidUTF8(c.doc) {
				t.Fatal("fixture must hold invalid UTF-8")
			}
			wantCheckRefusal(t, CheckCanonicalizable(c.doc), c.rule, c.path)
		})
	}
}

// Canonicalize hands back the check's own verdict for an ill-formed string,
// and gives it before JSON-LD processing: the second case names a context
// the loader does not know, so a verdict reached after loading contexts
// would carry ErrUnknownContext instead.
func TestCanonicalize_RefusesIllFormedStringsBeforeJSONLDProcessing(t *testing.T) {
	loader := NewDocumentLoader(nil)
	for _, c := range illFormedStringRefusals() {
		// json-gold reads a bare string document as a URL to load.
		if _, ok := c.doc.(string); ok {
			continue
		}
		t.Run(c.name, func(t *testing.T) {
			out, err := Canonicalize(c.doc, loader)
			if out != "" {
				t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
			}
			wantCheckRefusal(t, err, c.rule, c.path)
		})
	}

	t.Run("an ill-formed value beside an unregistered @context", func(t *testing.T) {
		doc := map[string]any{"@context": "https://attacker.example/evil-context.jsonld", "a": "\xed\xa0\x80"}
		_, err := Canonicalize(doc, loader)
		if errors.Is(err, ErrUnknownContext) {
			t.Errorf("err = %v carries ErrUnknownContext; the context was loaded before admission", err)
		}
		wantCheckRefusal(t, err, RuleIllFormedString, "/a")
	})

	t.Run("an ill-formed value in a credential under a registered @context", func(t *testing.T) {
		doc := map[string]any{"@context": W3CVCV1ContextURL, "type": "VerifiableCredential", "issuer": "did:web:x\xff"}
		out, err := Canonicalize(doc, loader)
		if out != "" {
			t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
		}
		wantCheckRefusal(t, err, RuleIllFormedString, "/issuer")
	})
}
