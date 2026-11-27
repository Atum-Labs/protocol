package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func node(t *testing.T, src string) *yaml.Node {
	t.Helper()
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(src), &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Content[0]
}

func emit(t *testing.T, n *yaml.Node) string {
	t.Helper()
	var sb strings.Builder
	enc := yaml.NewEncoder(&sb)
	enc.SetIndent(2)
	if err := enc.Encode(n); err != nil {
		t.Fatal(err)
	}
	enc.Close()
	return sb.String()
}

func TestApplyRemove(t *testing.T) {
	t.Run("drops a property and its required entry", func(t *testing.T) {
		n := node(t, "type: object\nrequired: [a, b]\nproperties:\n  a: {type: string}\n  b: {type: string}\n")
		if err := applyRemove(n, "S", []string{"properties.b"}); err != nil {
			t.Fatal(err)
		}
		var got struct {
			Required   []string       `yaml:"required"`
			Properties map[string]any `yaml:"properties"`
		}
		if err := n.Decode(&got); err != nil {
			t.Fatal(err)
		}
		if _, ok := got.Properties["b"]; ok {
			t.Error("property b survived the removal")
		}
		if _, ok := got.Properties["a"]; !ok {
			t.Error("property a was collateral damage")
		}
		if strings.Join(got.Required, ",") != "a" {
			t.Errorf("required = %v, want just [a]", got.Required)
		}
	})

	t.Run("drops one constraint without touching the property", func(t *testing.T) {
		n := node(t, "properties:\n  amount:\n    type: string\n    pattern: \"^[0-9]+$\"\n    minLength: 1\n")
		if err := applyRemove(n, "S", []string{"properties.amount.pattern"}); err != nil {
			t.Fatal(err)
		}
		got := emit(t, n)
		if strings.Contains(got, "pattern") {
			t.Errorf("pattern survived:\n%s", got)
		}
		for _, keep := range []string{"type: string", "minLength: 1"} {
			if !strings.Contains(got, keep) {
				t.Errorf("%q was removed too:\n%s", keep, got)
			}
		}
	})

	// A stale entry means the declaration moved on. Doing nothing would hide that.
	t.Run("a path that is not there is an error", func(t *testing.T) {
		n := node(t, "properties:\n  a: {type: string}\n")
		err := applyRemove(n, "S", []string{"properties.nope"})
		if err == nil || !strings.Contains(err.Error(), "properties.nope") {
			t.Errorf("want an error naming the stale path, got %v", err)
		}
	})

	t.Run("a missing intermediate segment is an error", func(t *testing.T) {
		n := node(t, "properties:\n  a: {type: string}\n")
		err := applyRemove(n, "S", []string{"properties.a.format.deep"})
		if err == nil {
			t.Error("want an error for an unreachable path")
		}
	})
}

func TestApplyOverlay(t *testing.T) {
	t.Run("merges into a nested property without restating siblings", func(t *testing.T) {
		n := node(t, "properties:\n  a:\n    type: string\n    description: keep me\n")
		if err := applyOverlay(n, node(t, "properties:\n  a:\n    example: hello\n")); err != nil {
			t.Fatal(err)
		}
		got := emit(t, n)
		for _, want := range []string{"type: string", "description: keep me", "example: hello"} {
			if !strings.Contains(got, want) {
				t.Errorf("missing %q:\n%s", want, got)
			}
		}
	})

	t.Run("a sequence replaces rather than merging", func(t *testing.T) {
		n := node(t, "required: [a, b]\n")
		if err := applyOverlay(n, node(t, "required: [a, b, c]\n")); err != nil {
			t.Fatal(err)
		}
		// Decoded rather than string-matched: the encoder is free to pick flow or block
		// style, and an assertion on the rendering would be testing the encoder.
		var got struct {
			Required []string `yaml:"required"`
		}
		if err := n.Decode(&got); err != nil {
			t.Fatal(err)
		}
		if strings.Join(got.Required, ",") != "a,b,c" {
			t.Errorf("required = %v, want [a b c] replacing the original", got.Required)
		}
	})

	// A manifest can anchor one shape's overlay and alias it from another, so two shapes that
	// must stay identical are written once.
	aliased := func(t *testing.T) *yaml.Node {
		t.Helper()
		doc := node(t, "base: &props\n  a:\n    example: hello\nover:\n  properties: *props\n")
		return mappingValue(doc, "over")
	}

	t.Run("an aliased mapping merges like one written in place", func(t *testing.T) {
		n := node(t, "properties:\n  a:\n    type: string\n  b:\n    type: integer\n")
		if err := applyOverlay(n, aliased(t)); err != nil {
			t.Fatal(err)
		}
		got := emit(t, n)
		for _, want := range []string{"type: string", "example: hello", "type: integer"} {
			if !strings.Contains(got, want) {
				t.Errorf("missing %q:\n%s", want, got)
			}
		}
	})

	t.Run("an aliased value set on a new key carries no anchor into the output", func(t *testing.T) {
		n := node(t, "type: object\n")
		if err := applyOverlay(n, aliased(t)); err != nil {
			t.Fatal(err)
		}
		got := emit(t, n)
		if !strings.Contains(got, "example: hello") || strings.Contains(got, "&") || strings.Contains(got, "*") {
			t.Errorf("want the anchored content without anchor or alias markers:\n%s", got)
		}
	})

	t.Run("an overlay that is not a mapping is an error, not a silent skip", func(t *testing.T) {
		n := node(t, "type: object\n")
		err := applyOverlay(n, node(t, "- not\n- a\n- mapping\n"))
		if err == nil {
			t.Error("want an error for a non-mapping overlay")
		}
	})
}

// yaml.v3 allocates a *yaml.Node struct field without filling it, so an overlay written
// in the manifest was parsed and then silently discarded. The field is a value for that
// reason, and this test fails if it is ever changed back.
func TestManifestOverlayIsActuallyDecoded(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "canonical-shapes.yaml")
	if err := os.WriteFile(path, []byte(`target: openapi.yaml
source: schema.json
shapes:
  - name: A
    from: $defs/A
    reason: carries an integrator example
    overlay:
      properties:
        x:
          example: hello
`), 0o644); err != nil {
		t.Fatal(err)
	}
	m, err := LoadManifest(path)
	if err != nil {
		t.Fatal(err)
	}
	s := m.Shapes[0]
	if !s.HasOverlay() {
		t.Fatal("HasOverlay() is false; the overlay was dropped during decoding")
	}
	target := node(t, "properties:\n  x:\n    type: string\n")
	if err := applyOverlay(target, &s.Overlay); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(emit(t, target), "example: hello") {
		t.Error("the manifest overlay did not reach the shape")
	}
}

// A divergence without a stated reason is the thing this manifest exists to prevent.
func TestDivergenceRequiresAReason(t *testing.T) {
	for _, body := range []string{
		"target: o.yaml\nsource: s.json\nshapes:\n  - name: A\n    from: $defs/A\n    remove: [properties.x]\n",
		"target: o.yaml\nsource: s.json\nshapes:\n  - name: A\n    from: $defs/A\n    overlay:\n      properties:\n        x:\n          example: y\n",
	} {
		dir := t.TempDir()
		path := filepath.Join(dir, "m.yaml")
		os.WriteFile(path, []byte(body), 0o644)
		_, err := LoadManifest(path)
		if err == nil || !strings.Contains(err.Error(), "reason") {
			t.Errorf("want a missing-reason error, got %v", err)
		}
	}
}

// yaml.v3 keeps both pairs of a duplicated key when decoding into a Node, so a duplicate
// appears to work here while a conventional reader takes the last and drops the first.
func TestOverlayRejectsDuplicateKeys(t *testing.T) {
	target := node(t, "properties:\n  a:\n    type: string\n")
	dup := node(t, "properties:\n  a:\n    description: one\nproperties:\n  a:\n    example: two\n")
	err := applyOverlay(target, dup)
	if err == nil {
		t.Fatal("want an error for a duplicated overlay key")
	}
	if !strings.Contains(err.Error(), "twice") {
		t.Errorf("error does not explain the problem: %v", err)
	}
}

func TestOverlayRejectsDuplicatesNestedUnderProperties(t *testing.T) {
	target := node(t, "properties:\n  a:\n    type: string\n")
	dup := node(t, "properties:\n  a:\n    description: one\n  a:\n    example: two\n")
	if err := applyOverlay(target, dup); err == nil {
		t.Fatal("want an error for a nested duplicate")
	}
}
