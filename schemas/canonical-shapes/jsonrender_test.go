package main

import (
	"encoding/json"
	"testing"

	"gopkg.in/yaml.v3"
)

func renderFrom(t *testing.T, src string, indent int) string {
	t.Helper()
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(src), &doc); err != nil {
		t.Fatal(err)
	}
	out, err := renderJSON(doc.Content[0], indent)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRenderJSON(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "an object expands one key per line",
			in:   `{"a": "x", "b": "y"}`,
			want: "{\n  \"a\": \"x\",\n  \"b\": \"y\"\n}",
		},
		{
			name: "key order follows the source, not sorting",
			in:   `{"z": 1, "a": 2, "m": 3}`,
			want: "{\n  \"z\": 1,\n  \"a\": 2,\n  \"m\": 3\n}",
		},
		{
			name: "arrays expand one item per line",
			in:   `{"required": ["b", "a"]}`,
			want: "{\n  \"required\": [\n    \"b\",\n    \"a\"\n  ]\n}",
		},
		{
			name: "empty containers stay compact",
			in:   `{"a": {}, "b": []}`,
			want: "{\n  \"a\": {},\n  \"b\": []\n}",
		},
		{
			name: "scalar types survive the round trip",
			in:   `{"s": "1", "i": 1, "f": 1.5, "t": true, "n": null}`,
			want: "{\n  \"s\": \"1\",\n  \"i\": 1,\n  \"f\": 1.5,\n  \"t\": true,\n  \"n\": null\n}",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := renderFrom(t, tc.in, 0); got != tc.want {
				t.Errorf("\n got: %q\nwant: %q", got, tc.want)
			}
		})
	}
}

// Descriptions in these schemas carry quotes, backslashes and non-ASCII arrows. Escaping
// them by hand is how a generator writes a file that no longer parses.
func TestRenderJSONEscapesLikeAJSONWriter(t *testing.T) {
	in := `{"description": "a \"quoted\" value, a back\\slash, an arrow → and a newline\nhere"}`
	got := renderFrom(t, in, 0)

	var round map[string]string
	if err := json.Unmarshal([]byte(got), &round); err != nil {
		t.Fatalf("rendered output does not parse as JSON: %v\n%s", err, got)
	}
	var orig map[string]string
	json.Unmarshal([]byte(in), &orig)
	if round["description"] != orig["description"] {
		t.Errorf("value changed through rendering:\n got %q\nwant %q", round["description"], orig["description"])
	}
}

func TestRenderJSONIndentsNestedStructures(t *testing.T) {
	got := renderFrom(t, `{"outer": {"inner": ["x"]}}`, 4)
	want := "{\n      \"outer\": {\n        \"inner\": [\n          \"x\"\n        ]\n      }\n    }"
	if got != want {
		t.Errorf("\n got: %q\nwant: %q", got, want)
	}
}

// The real check: anything this renders must be readable back as the same document.
func TestRenderJSONRoundTripsTheSharedSource(t *testing.T) {
	raw, err := readFileForTest("../declarations/common/shapes/v1/schema.json")
	if err != nil {
		t.Skipf("shared source not present: %v", err)
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	out, err := renderJSON(doc.Content[0], 0)
	if err != nil {
		t.Fatal(err)
	}
	var a, b any
	if err := json.Unmarshal(raw, &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(out), &b); err != nil {
		t.Fatalf("rendered shared source does not parse: %v", err)
	}
	if !jsonEqualForTest(a, b) {
		t.Error("rendering the shared source changed its content")
	}
}
