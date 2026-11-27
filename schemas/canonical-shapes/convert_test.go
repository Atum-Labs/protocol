package main

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// convertYAML runs the dialect conversion over a literal document and returns the
// re-emitted YAML, so a case reads as "this canonical fragment becomes this OpenAPI one".
func convertYAML(t *testing.T, in string) (string, []Drop) {
	t.Helper()
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(in), &doc); err != nil {
		t.Fatalf("parsing input: %v", err)
	}
	c := &converter{}
	out := c.convert(doc.Content[0], "Shape")
	var sb strings.Builder
	enc := yaml.NewEncoder(&sb)
	enc.SetIndent(2)
	if err := enc.Encode(out); err != nil {
		t.Fatalf("encoding output: %v", err)
	}
	enc.Close()
	return sb.String(), c.sortedDrops()
}

func TestConvertDialect(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "document meta keywords are stripped",
			in:   "{\"$schema\": \"x\", \"$id\": \"y\", \"title\": \"T\", \"type\": \"object\"}",
			want: "type: object\n",
		},
		{
			name: "internal $defs pointers are rebased onto the flat component namespace",
			in:   "{\"$ref\": \"#/$defs/VerifiableCredential\"}",
			want: "$ref: '#/components/schemas/VerifiableCredential'\n",
		},
		{
			name: "the 2020-12 examples array becomes a single OpenAPI example",
			in:   "{\"type\": \"string\", \"examples\": [\"1.0\", \"1.1\"]}",
			want: "type: string\nexample: \"1.0\"\n",
		},
		{
			name: "const becomes a single-valued enum",
			in:   "{\"const\": \"VerifiableCredential\"}",
			want: "enum:\n  - VerifiableCredential\n",
		},
		{
			name: "a nullable type array becomes type plus nullable",
			in:   "{\"type\": [\"string\", \"null\"]}",
			want: "type: string\nnullable: true\n",
		},
		{
			name: "keywords both dialects share pass through untouched",
			in:   "{\"type\": \"string\", \"pattern\": \"^[0-9]+$\", \"minLength\": 1, \"format\": \"date-time\"}",
			want: "type: string\npattern: ^[0-9]+$\nminLength: 1\nformat: date-time\n",
		},
		{
			name: "key order is preserved exactly",
			in:   "{\"description\": \"d\", \"type\": \"object\", \"required\": [\"b\", \"a\"]}",
			want: "description: d\ntype: object\nrequired:\n  - b\n  - a\n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, _ := convertYAML(t, tc.in)
			if got != tc.want {
				t.Errorf("\n got: %q\nwant: %q", got, tc.want)
			}
		})
	}
}

// A keyword OAS 3.0.3 cannot express is a validation rule the published contract will not
// enforce. Silently dropping one is how a contract loosens without anyone noticing, so the
// tool has to report every drop.
func TestUnsupportedKeywordsAreDroppedAndReported(t *testing.T) {
	got, drops := convertYAML(t, `{
	  "type": "array",
	  "contains": {"const": "https://www.w3.org/2018/credentials/v1"},
	  "items": {"type": "string"}
	}`)
	if strings.Contains(got, "contains") {
		t.Errorf("contains survived into OpenAPI output:\n%s", got)
	}
	if len(drops) != 1 {
		t.Fatalf("want exactly 1 reported drop, got %d: %v", len(drops), drops)
	}
	if drops[0].Keyword != "contains" || drops[0].Path != "Shape" {
		t.Errorf("drop reported as %v, want path Shape keyword contains", drops[0])
	}
}

func TestNestedDropsReportTheirPath(t *testing.T) {
	_, drops := convertYAML(t, `{
	  "properties": {
	    "@context": {"type": "array", "contains": {"const": "x"}},
	    "type":     {"type": "array", "contains": {"const": "y"}}
	  }
	}`)
	if len(drops) != 2 {
		t.Fatalf("want 2 drops, got %d: %v", len(drops), drops)
	}
	want := "Shape.properties.@context.contains"
	if drops[0].String() != want {
		t.Errorf("first drop %q, want %q", drops[0], want)
	}
}

// A union of concrete types has no OpenAPI 3.0.3 spelling. Emitting a guess would put an
// invalid schema into a published contract, so the run has to fail.
func TestConcreteTypeUnionIsAnError(t *testing.T) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(`{"type": ["string", "integer"]}`), &doc); err != nil {
		t.Fatal(err)
	}
	c := &converter{}
	c.convert(doc.Content[0], "Shape")
	err := c.Err()
	if err == nil {
		t.Fatal("want an error for a concrete type union, got nil")
	}
	if !strings.Contains(err.Error(), "oneOf") {
		t.Errorf("error %q does not say what to do instead", err)
	}
}

// The nullable form must keep working: it is the one type array OAS 3.0 can express.
func TestNullableUnionIsNotAnError(t *testing.T) {
	got, _ := convertYAML(t, `{"type": ["string", "null"]}`)
	if got != "type: string\nnullable: true\n" {
		t.Errorf("got %q", got)
	}
	var doc yaml.Node
	yaml.Unmarshal([]byte(`{"type": ["string", "null"]}`), &doc)
	c := &converter{}
	c.convert(doc.Content[0], "Shape")
	if err := c.Err(); err != nil {
		t.Errorf("nullable union reported an error: %v", err)
	}
}

// A description carrying the indentation of the document it was authored in turns into an
// indented block once re-homed, which renderers show as preformatted code instead of the
// list it is meant to be.
func TestMultiLineDescriptionsAreDedented(t *testing.T) {
	got, _ := convertYAML(t, `{"description": "Formats:\n            - EVM: hex\n            - Solana: hex"}`)
	if strings.Contains(got, "            - EVM") {
		t.Errorf("stale indentation survived:\n%s", got)
	}
	if !strings.Contains(got, "- EVM: hex") || !strings.Contains(got, "- Solana: hex") {
		t.Errorf("dedent lost content:\n%s", got)
	}
}

func TestDedentPreservesRelativeIndentation(t *testing.T) {
	if got, want := dedent("head\n    a\n        b"), "head\na\n    b"; got != want {
		t.Errorf("dedent = %q, want %q", got, want)
	}
}

func TestDedentLeavesUnindentedTextAlone(t *testing.T) {
	in := "head\nplain\nlines"
	if got := dedent(in); got != in {
		t.Errorf("dedent changed unindented text: %q", got)
	}
}

// A dropped keyword means the generated contract validates less than its source. Printing
// it is not enough: regeneration is deterministic, so the same drop reproduces every run,
// the drift guard sees no diff, and CI stays green while the contract quietly loosens.
func TestUndeclaredDropFails(t *testing.T) {
	var doc yaml.Node
	yaml.Unmarshal([]byte(`{"type": "array", "contains": {"const": "x"}}`), &doc)
	c := &converter{}
	c.convert(doc.Content[0], "Shape")

	if err := c.CheckDrops(nil); err == nil {
		t.Fatal("an undeclared drop must fail")
	} else if !strings.Contains(err.Error(), "Shape.contains") {
		t.Errorf("error does not name the drop: %v", err)
	}
	if err := c.CheckDrops([]string{"Shape.contains"}); err != nil {
		t.Errorf("a declared drop must pass: %v", err)
	}
}

// A declared drop that no longer happens has to fail too, or it sits in the manifest
// masking the next real one.
func TestStaleExpectedDropFails(t *testing.T) {
	c := &converter{}
	err := c.CheckDrops([]string{"Shape.somethingThatNeverDrops"})
	if err == nil {
		t.Fatal("a stale expected_drops entry must fail")
	}
	if !strings.Contains(err.Error(), "no longer happens") {
		t.Errorf("error does not explain staleness: %v", err)
	}
}

// A line ending in a space forces the emitter to fall back to a quoted scalar with escaped
// newlines, which reads badly in a published contract. It must be trimmed whether or not
// the text also carries indentation to remove.
func TestTrailingWhitespaceIsTrimmedWithAndWithoutIndent(t *testing.T) {
	for name, in := range map[string]string{
		"no common indent": "first line \nsecond line",
		"with indent":      "head\n    indented \n    more  ",
	} {
		got := dedent(in)
		for _, line := range strings.Split(got, "\n") {
			if line != strings.TrimRight(line, " \t") {
				t.Errorf("%s: line %q keeps trailing whitespace", name, line)
			}
		}
	}
}

// "only null" and "more than one concrete type" are different problems with different
// advice. Reporting the second for the first sends the reader looking for a union that
// isn't there.
func TestNullOnlyTypeIsReportedAsItsOwnProblem(t *testing.T) {
	var doc yaml.Node
	yaml.Unmarshal([]byte(`{"type": ["null"]}`), &doc)
	c := &converter{}
	c.convert(doc.Content[0], "Shape")
	err := c.Err()
	if err == nil {
		t.Fatal("want an error for a null-only type")
	}
	if !strings.Contains(err.Error(), "allows only null") {
		t.Errorf("error misdescribes the problem: %v", err)
	}
	if strings.Contains(err.Error(), "union") {
		t.Errorf("error calls a null-only type a union: %v", err)
	}
}
