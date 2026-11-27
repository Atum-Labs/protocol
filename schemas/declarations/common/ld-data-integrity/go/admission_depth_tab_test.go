package lddataintegrity

import (
	"errors"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// pointerToken is the test's own RFC 6901 escaping of one key.
func pointerToken(k string) string {
	return strings.ReplaceAll(strings.ReplaceAll(k, "~", "~0"), "/", "~1")
}

// sortedKeys is the walk order of an object's members: code point order,
// which for UTF-8 strings is the byte order sort.Strings gives.
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// resolvePointer is the test's own reading of an RFC 6901 pointer into a
// decoded document.
func resolvePointer(doc any, ptr string) (any, bool) {
	if ptr == "" {
		return doc, true
	}
	if !strings.HasPrefix(ptr, "/") {
		return nil, false
	}
	v := doc
	for _, tok := range strings.Split(ptr[1:], "/") {
		tok = strings.ReplaceAll(strings.ReplaceAll(tok, "~1", "/"), "~0", "~")
		switch x := v.(type) {
		case map[string]any:
			c, ok := x[tok]
			if !ok {
				return nil, false
			}
			v = c
		case []any:
			i, err := strconv.Atoi(tok)
			if err != nil || i < 0 || i >= len(x) {
				return nil, false
			}
			v = x[i]
		default:
			return nil, false
		}
	}
	return v, true
}

// firstContainerAtDepth is the pointer of the first object or array at depth
// want in walk order, the root being at depth 1, or false if none is that
// deep. It is the test's own statement of where a depth-budget refusal must
// point.
func firstContainerAtDepth(v any, want int) (string, bool) {
	var find func(v any, path string, depth int) (string, bool)
	find = func(v any, path string, depth int) (string, bool) {
		switch x := v.(type) {
		case map[string]any:
			if depth == want {
				return path, true
			}
			for _, k := range sortedKeys(x) {
				if p, ok := find(x[k], path+"/"+pointerToken(k), depth+1); ok {
					return p, true
				}
			}
		case []any:
			if depth == want {
				return path, true
			}
			for i, c := range x {
				if p, ok := find(c, path+"/"+strconv.Itoa(i), depth+1); ok {
					return p, true
				}
			}
		}
		return "", false
	}
	return find(v, "", 1)
}

// firstTabValue is the pointer of the first string value holding U+0009 in
// walk order, keys not considered.
func firstTabValue(v any) (string, bool) {
	var find func(v any, path string) (string, bool)
	find = func(v any, path string) (string, bool) {
		switch x := v.(type) {
		case string:
			return path, strings.Contains(x, "\t")
		case map[string]any:
			for _, k := range sortedKeys(x) {
				if p, ok := find(x[k], path+"/"+pointerToken(k)); ok {
					return p, true
				}
			}
		case []any:
			for i, c := range x {
				if p, ok := find(c, path+"/"+strconv.Itoa(i)); ok {
					return p, true
				}
			}
		}
		return "", false
	}
	return find(v, "")
}

// walkPosition is the 1-based position of the value at ptr among the values
// the walk visits, counted as the value budget counts them.
func walkPosition(doc any, ptr string) (int, bool) {
	n := 0
	var visit func(v any, path string) bool
	visit = func(v any, path string) bool {
		n++
		if path == ptr {
			return true
		}
		switch x := v.(type) {
		case map[string]any:
			for _, k := range sortedKeys(x) {
				if visit(x[k], path+"/"+pointerToken(k)) {
					return true
				}
			}
		case []any:
			for i, c := range x {
				if visit(c, path+"/"+strconv.Itoa(i)) {
					return true
				}
			}
		}
		return false
	}
	return n, visit(doc, "")
}

// holdsOnly reports whether every object or array in v is an object (maps)
// or every one is an array.
func holdsOnly(v any, maps bool) bool {
	switch x := v.(type) {
	case map[string]any:
		if !maps {
			return false
		}
		for _, c := range x {
			if !holdsOnly(c, maps) {
				return false
			}
		}
	case []any:
		if maps {
			return false
		}
		for _, c := range x {
			if !holdsOnly(c, maps) {
				return false
			}
		}
	}
	return true
}

func stringValuesHoldTab(v any) bool {
	_, ok := firstTabValue(v)
	return ok
}

func keysHoldTab(v any) bool {
	switch x := v.(type) {
	case map[string]any:
		for k, c := range x {
			if strings.Contains(k, "\t") || keysHoldTab(c) {
				return true
			}
		}
	case []any:
		for _, c := range x {
			if keysHoldTab(c) {
				return true
			}
		}
	}
	return false
}

// nestedObjects is n objects, each but the innermost holding the next under
// key; the innermost is inner, or empty when inner is nil.
func nestedObjects(n int, key string, inner map[string]any) map[string]any {
	v := inner
	if v == nil {
		v = map[string]any{}
	}
	for i := 1; i < n; i++ {
		v = map[string]any{key: v}
	}
	return v
}

// nestedArrays is n arrays, each but the innermost holding the next; the
// innermost holds inner.
func nestedArrays(n int, inner ...any) []any {
	v := append([]any{}, inner...)
	for i := 1; i < n; i++ {
		v = []any{v}
	}
	return v
}

// Guards the depth and tab vectors of the shared file: each depth-budget
// refusal points at the first object or array at depth 33 in walk order, and
// each tab-character refusal at the first string value holding a tab; the
// boundary vectors sit at exactly 32 and 33 levels and are built of the one
// kind of container their names say; the value-budget precedence pair puts
// that object at exactly the 1025th and 1024th value; and the tab-key vector
// holds tabs in keys only. Without this a fixture edit could move a vector
// off the boundary it is named for.
func TestAdmissionVectors_DepthAndTabVectorsSitWhereTheirNamesSay(t *testing.T) {
	f := loadAdmissionVectors(t)
	depthRefusals, tabRefusals := 0, 0
	for _, v := range f.Refuse {
		if v.Rule == nil || v.Path == nil {
			continue
		}
		switch AdmissionRule(*v.Rule) {
		case ruleDepthBudget:
			depthRefusals++
			if d := jsonDepth(v.Doc); d <= admissionDepthBudget {
				t.Errorf("refuse %q is %d levels deep, within the depth budget of %d", v.Name, d, admissionDepthBudget)
			}
			if p, ok := firstContainerAtDepth(v.Doc, admissionDepthBudget+1); !ok || p != *v.Path {
				t.Errorf("refuse %q: first object or array at depth %d in walk order is %q (found %v), vector path %q", v.Name, admissionDepthBudget+1, p, ok, *v.Path)
			}
		case ruleTabCharacter:
			tabRefusals++
			if p, ok := firstTabValue(v.Doc); !ok || p != *v.Path {
				t.Errorf("refuse %q: first tab-holding string value in walk order is %q (found %v), vector path %q", v.Name, p, ok, *v.Path)
			}
		}
	}
	if depthRefusals == 0 || tabRefusals == 0 {
		t.Errorf("%d depth-budget and %d tab-character refuse vectors with exact paths, want both non-zero", depthRefusals, tabRefusals)
	}

	for _, c := range []struct {
		list  []admissionVector
		name  string
		depth int
		maps  bool
	}{
		{f.Accept, "depth budget boundary: 32 nested objects", admissionDepthBudget, true},
		{f.Accept, "depth budget boundary: 32 nested arrays", admissionDepthBudget, false},
		{f.Refuse, "depth budget boundary: 33 nested objects", admissionDepthBudget + 1, true},
		{f.Refuse, "depth budget boundary: 33 nested arrays", admissionDepthBudget + 1, false},
	} {
		v := findAdmissionVector(t, c.list, c.name)
		if d := jsonDepth(v.Doc); d != c.depth {
			t.Errorf("%q is %d levels deep, want %d", v.Name, d, c.depth)
		}
		if !holdsOnly(v.Doc, c.maps) {
			t.Errorf("%q mixes objects and arrays, want only one kind", v.Name)
		}
	}
	for _, name := range []string{
		"depth budget boundary: 32 levels alternating objects and arrays",
		"depth budget: scalars add no depth (32 nested objects",
		"depth budget: scalars add no depth (32 nested arrays",
	} {
		if v := findAdmissionVector(t, f.Accept, name); jsonDepth(v.Doc) != admissionDepthBudget {
			t.Errorf("%q is %d levels deep, want %d", v.Name, jsonDepth(v.Doc), admissionDepthBudget)
		}
	}
	for _, c := range []struct {
		name     string
		position int
	}{
		{"depth budget: the value budget wins when the object at depth 33 is the 1025th value", 1025},
		{"depth budget: the object at depth 33 as the 1024th value", 1024},
	} {
		v := findAdmissionVector(t, f.Refuse, c.name)
		p, ok := firstContainerAtDepth(v.Doc, admissionDepthBudget+1)
		if !ok {
			t.Fatalf("%q holds no object or array at depth %d", v.Name, admissionDepthBudget+1)
		}
		if n, found := walkPosition(v.Doc, p); !found || n != c.position {
			t.Errorf("%q: the object at depth %d is value %d in walk order (found %v), want %d", v.Name, admissionDepthBudget+1, n, found, c.position)
		}
		if n := countJSONValues(v.Doc); n != c.position {
			t.Errorf("%q holds %d values, want %d", v.Name, n, c.position)
		}
	}
	keys := findAdmissionVector(t, f.Accept, "tab character: keys are not checked")
	if !keysHoldTab(keys.Doc) || stringValuesHoldTab(keys.Doc) {
		t.Errorf("%q: tabs in keys %v, in string values %v; want keys only", keys.Name, keysHoldTab(keys.Doc), stringValuesHoldTab(keys.Doc))
	}
	for _, v := range f.Accept {
		if v.Name != keys.Name && stringValuesHoldTab(v.Doc) {
			t.Errorf("accept %q holds a tab in a string value", v.Name)
		}
		if d := jsonDepth(v.Doc); d > admissionDepthBudget {
			t.Errorf("accept %q is %d levels deep, over the depth budget of %d", v.Name, d, admissionDepthBudget)
		}
	}
}

// The depth budget from both sides for each shape of nesting, at the root
// and below it. Deeper documents are reported at the same pointer, the first
// object or array past the budget, because the walk does not go further.
func TestCheckCanonicalizable_DepthBudgetBoundary(t *testing.T) {
	obj := func(n int) any { return nestedObjects(n, "a", nil) }
	arr := func(n int) any { return nestedArrays(n) }
	alternating := func(n int) any {
		var v any
		if n%2 == 1 {
			v = map[string]any{}
		} else {
			v = []any{}
		}
		for level := n - 1; level >= 1; level-- {
			if level%2 == 1 {
				v = map[string]any{"a": v}
			} else {
				v = []any{v}
			}
		}
		return v
	}
	underRoot := func(n int) any {
		return map[string]any{"x": 1.0, "k": nestedObjects(n-1, "k", map[string]any{"s": "v"})}
	}
	underRootArray := func(n int) any {
		return []any{"x", nestedArrays(n-1, 1.0, "s", nil, true)}
	}
	for _, c := range []struct {
		name  string
		build func(int) any
		path  string
	}{
		{"nested objects", obj, strings.Repeat("/a", admissionDepthBudget)},
		{"nested arrays", arr, strings.Repeat("/0", admissionDepthBudget)},
		{"alternating objects and arrays", alternating, strings.Repeat("/a/0", admissionDepthBudget/2)},
		{"objects under a root object with a scalar sibling", underRoot, strings.Repeat("/k", admissionDepthBudget)},
		{"arrays holding scalars under a root array", underRootArray, "/1" + strings.Repeat("/0", admissionDepthBudget-1)},
	} {
		t.Run(c.name+"/32 levels are admitted", func(t *testing.T) {
			doc := c.build(admissionDepthBudget)
			if d := jsonDepth(doc); d != admissionDepthBudget {
				t.Fatalf("fixture is %d levels deep, want %d", d, admissionDepthBudget)
			}
			if err := CheckCanonicalizable(doc); err != nil {
				t.Errorf("CheckCanonicalizable = %v, want nil", err)
			}
		})
		for _, depth := range []int{admissionDepthBudget + 1, admissionDepthBudget + 2, 100} {
			t.Run(c.name+"/"+strconv.Itoa(depth)+" levels are refused at the first object or array at depth 33", func(t *testing.T) {
				doc := c.build(depth)
				if d := jsonDepth(doc); d != depth {
					t.Fatalf("fixture is %d levels deep, want %d", d, depth)
				}
				if p, _ := firstContainerAtDepth(doc, admissionDepthBudget+1); p != c.path {
					t.Fatalf("fixture's first object or array at depth %d is %q, want %q", admissionDepthBudget+1, p, c.path)
				}
				wantCheckRefusal(t, CheckCanonicalizable(doc), ruleDepthBudget, c.path)
			})
		}
	}
}

// Precedence cases only Go can build, because JSON text cannot carry invalid
// UTF-8 to CheckCanonicalizable. The key rules judge a key before the walk
// enters its value, so an ill-formed key holding the too-deep object is
// reported under ill-formed-string; a value the walk never enters is never
// judged.
func TestCheckCanonicalizable_DepthBudgetPrecedenceWithIllFormedStrings(t *testing.T) {
	deep := func(inner map[string]any) map[string]any { return nestedObjects(admissionDepthBudget, "k", inner) }
	prefix := strings.Repeat("/k", admissionDepthBudget-1)
	for _, c := range []illFormedStringCase{
		{"an ill-formed key holding the too-deep object is reported by the key rule", deep(map[string]any{"\xff": map[string]any{}}), RuleIllFormedString, prefix + "/\xff"},
		{"an ill-formed string visited before the too-deep object is reported first", map[string]any{"a": "\xff", "b": deep(nil)}, RuleIllFormedString, "/a"},
		{"an ill-formed string inside the too-deep object is never judged", deep(map[string]any{"x": map[string]any{"s": "\xff"}}), ruleDepthBudget, prefix + "/x"},
	} {
		t.Run(c.name, func(t *testing.T) {
			if !holdsInvalidUTF8(c.doc) {
				t.Fatal("fixture must hold invalid UTF-8")
			}
			if d := jsonDepth(c.doc); d <= admissionDepthBudget {
				t.Fatalf("fixture is %d levels deep, want more than %d", d, admissionDepthBudget)
			}
			wantCheckRefusal(t, CheckCanonicalizable(c.doc), c.rule, c.path)
		})
	}
}

// The depth budget is judged before any JSON-LD processing: the first
// document names a context no loader knows, so a verdict reached after
// loading contexts would carry ErrUnknownContext; the second is a chain of
// graph containers under a context the loader resolves, which json-gold
// would otherwise expand.
func TestCanonicalize_RefusesTooDeepDocumentsBeforeJSONLDProcessing(t *testing.T) {
	t.Run("beside an unregistered @context", func(t *testing.T) {
		doc := map[string]any{"@context": "https://attacker.example/evil-context.jsonld", "a": nestedObjects(admissionDepthBudget, "a", nil)}
		out, err := Canonicalize(doc, NewDocumentLoader(nil))
		if errors.Is(err, ErrUnknownContext) {
			t.Errorf("err = %v carries ErrUnknownContext; the context was loaded before admission", err)
		}
		if out != "" {
			t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
		}
		wantCheckRefusal(t, err, ruleDepthBudget, strings.Repeat("/a", admissionDepthBudget))
	})
	t.Run("600 nested proof graph containers under the PaymentRequest context", func(t *testing.T) {
		v := findAdmissionVector(t, loadAdmissionVectors(t).Refuse, "depth budget: 600 nested proof graph containers")
		out, err := Canonicalize(copyJSON(t, v.Doc), datasetLoader(t, loadDatasetVectors(t)))
		if out != "" {
			t.Errorf("Canonicalize output is %d bytes alongside an error, want empty", len(out))
		}
		wantCheckRefusal(t, err, ruleDepthBudget, strings.Repeat("/proof", admissionDepthBudget))
	})
}

// Only U+0009 is refused, wherever it sits in a string value. Every other
// whitespace and control character, and a backslash followed by t, is
// admitted, as are tabs in keys.
func TestCheckCanonicalizable_TabCharacter(t *testing.T) {
	for _, c := range []struct {
		name string
		doc  any
		path string
	}{
		{"at the start of a value", map[string]any{"a": "\tx"}, "/a"},
		{"at the end of a value", map[string]any{"a": "x\t"}, "/a"},
		{"between multi-byte characters", map[string]any{"a": "é\t😀"}, "/a"},
		{"several in one value", map[string]any{"a": "\t\t"}, "/a"},
		{"in a value under a key needing JSON Pointer escaping", map[string]any{"a/b~c": "\t"}, "/a~1b~0c"},
		{"as the whole document", "\t", ""},
		{"inside a root array", []any{1.0, "\t"}, "/1"},
		{"in the second string of an @context array", map[string]any{"@context": []any{W3CVCV1ContextURL, "x\ty"}}, "/@context/1"},
	} {
		t.Run("refuses a tab "+c.name, func(t *testing.T) {
			if p, ok := firstTabValue(c.doc); !ok || p != c.path {
				t.Fatalf("fixture's first tab-holding value is %q (found %v), want %q", p, ok, c.path)
			}
			wantCheckRefusal(t, CheckCanonicalizable(c.doc), ruleTabCharacter, c.path)
		})
	}
	for _, c := range []struct {
		name string
		doc  any
	}{
		{"a backslash followed by t", map[string]any{"a": `x\ty`}},
		{"LF, CR, VT, FF and space", map[string]any{"a": "\n\r\v\f "}},
		{"NUL, backspace, U+001F and DEL", map[string]any{"a": "\x00\b\x1f\x7f"}},
		{"NEL, no-break space, thin space and ideographic space", map[string]any{"a": "\u0085  　"}},
		{"a tab in a root key", map[string]any{"\t": "x"}},
		{"a tab in a nested key holding an array", map[string]any{"a": map[string]any{"b\tc": []any{"x"}}}},
	} {
		t.Run("admits "+c.name, func(t *testing.T) {
			if stringValuesHoldTab(c.doc) {
				t.Fatal("fixture must hold no tab in a string value")
			}
			if err := CheckCanonicalizable(c.doc); err != nil {
				t.Errorf("CheckCanonicalizable = %v, want nil", err)
			}
		})
	}
}

// Within one string value its bytes are counted, then it is judged
// well-formed, then tab-character applies, then blank-node-label. The
// ill-formed cases exist only in Go, whose documents built in code can carry
// invalid UTF-8; the tab's position in the value must not matter.
func TestCheckCanonicalizable_TabCharacterPrecedenceWithIllFormedStrings(t *testing.T) {
	for _, c := range []illFormedStringCase{
		{"an ill-formed value is reported before its tab when the tab comes first", map[string]any{"a": "\t\xff"}, RuleIllFormedString, "/a"},
		{"an ill-formed value is reported before its tab when the tab comes last", map[string]any{"a": "\xff\t"}, RuleIllFormedString, "/a"},
		{"an ill-formed blank-node label with a tab is reported as ill-formed", map[string]any{"a": "_:\t\xff"}, RuleIllFormedString, "/a"},
		{"an ill-formed key holding a tab value is reported at the key", map[string]any{"\xff": "\t"}, RuleIllFormedString, "/\xff"},
		{"a tab value before an ill-formed sibling in code point order is reported first", map[string]any{"a": "\t", "b": "\xff"}, ruleTabCharacter, "/a"},
	} {
		t.Run(c.name, func(t *testing.T) {
			if !holdsInvalidUTF8(c.doc) {
				t.Fatal("fixture must hold invalid UTF-8")
			}
			wantCheckRefusal(t, CheckCanonicalizable(c.doc), c.rule, c.path)
		})
	}
}

// The tab rule is judged before any JSON-LD processing, so a document naming
// a context no loader knows is refused for its tab, not for the context.
func TestCanonicalize_RefusesTabCharactersBeforeJSONLDProcessing(t *testing.T) {
	doc := map[string]any{"@context": "https://attacker.example/evil-context.jsonld", "a": "x\ty"}
	out, err := Canonicalize(doc, NewDocumentLoader(nil))
	if errors.Is(err, ErrUnknownContext) {
		t.Errorf("err = %v carries ErrUnknownContext; the context was loaded before admission", err)
	}
	if out != "" {
		t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
	}
	wantCheckRefusal(t, err, ruleTabCharacter, "/a")
}

// The reason for the tab rule, pinned on the Go side: json-gold writes a TAB
// in a literal as the two-character escape, where the TypeScript suite pins
// that rdf-canonize writes the character itself. A json-gold release that
// stopped escaping it would fail here, and the rule could be revisited.
func TestReferenceNormalize_WritesATabInALiteralAsAnEscape(t *testing.T) {
	doc := map[string]any{"@context": W3CVCV1ContextURL, "type": "VerifiableCredential", "issuanceDate": "a\tb"}
	out, err := referenceNormalize(doc, NewDocumentLoader(nil))
	if err != nil {
		t.Fatalf("reference Normalize: %v", err)
	}
	if !strings.Contains(out, `"a\tb"`) {
		t.Errorf("json-gold output does not carry the literal as \"a\\tb\":\n%s", out)
	}
	if strings.Contains(out, "\t") {
		t.Errorf("json-gold output carries a raw TAB:\n%q", out)
	}
}

// withoutTabKeys is the document with every member whose key holds U+0009
// removed, at any depth.
func withoutTabKeys(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, c := range x {
			if !strings.Contains(k, "\t") {
				out[k] = withoutTabKeys(c)
			}
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, c := range x {
			out[i] = withoutTabKeys(c)
		}
		return out
	}
	return v
}

// The tab rule leaves keys unchecked on the premise that a key reaches the
// output only through a term its context defines. Under a real context that
// defines no such term, the output must be exactly what the document gives
// without the tab-holding key, and so hold no TAB for the serializers to
// write differently.
func TestCanonicalize_TabInAKeyUnderARealContextNeverReachesTheOutput(t *testing.T) {
	v := findAdmissionVector(t, loadAdmissionVectors(t).Accept, "tab character: a key holding U+0009 under the W3C credentials v1 context")
	if !keysHoldTab(v.Doc) || stringValuesHoldTab(v.Doc) {
		t.Fatalf("fixture: tabs in keys %v, in string values %v; want keys only", keysHoldTab(v.Doc), stringValuesHoldTab(v.Doc))
	}
	if v.Nquads == nil || *v.Nquads == "" {
		t.Fatalf("fixture must carry a non-empty verbatim expected output, got %v", v.Nquads)
	}
	loader := NewDocumentLoader(nil)
	got, err := Canonicalize(copyJSON(t, v.Doc), loader)
	if err != nil {
		t.Fatalf("Canonicalize = %v, want admission", err)
	}
	if got != *v.Nquads {
		t.Errorf("output differs from the shared expected output\n--- got ---\n%s\n--- expected ---\n%s", got, *v.Nquads)
	}
	if strings.Contains(got, "\t") {
		t.Errorf("output holds a TAB:\n%q", got)
	}
	stripped := withoutTabKeys(copyJSON(t, v.Doc))
	if keysHoldTab(stripped) {
		t.Fatal("withoutTabKeys left a tab-holding key")
	}
	want, err := Canonicalize(stripped, loader)
	if err != nil {
		t.Fatalf("Canonicalize without the tab-holding key = %v, want admission", err)
	}
	if got != want {
		t.Errorf("the tab-holding key changed the output\n--- with it ---\n%s\n--- without it ---\n%s", got, want)
	}
}
