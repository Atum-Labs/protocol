package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixture lays out a manifest, a canonical declaration and a spec the way the real tree
// does, and returns the manifest path.
func fixture(t *testing.T, canonical, spec string) (manifestPath, specPath string) {
	t.Helper()
	dir := t.TempDir()
	specPath = filepath.Join(dir, "openapi.yaml")
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("schema.json", canonical)
	write("openapi.yaml", spec)
	write("canonical-shapes.yaml",
		"target: openapi.yaml\nsource: schema.json\nshapes:\n  - name: Target\n    from: $defs/Target\n")
	return filepath.Join(dir, "canonical-shapes.yaml"), specPath
}

const e2eSpec = `openapi: 3.0.3
paths: {}
components:
  schemas:
    Before:
      type: string

    Target:
      type: object
      properties:
        stale:
          type: string

    After:
      type: string
`

func TestRunReplacesTheComponentFromCanonical(t *testing.T) {
	manifest, specPath := fixture(t, `{
	  "$schema": "https://json-schema.org/draft/2020-12/schema",
	  "$defs": {
	    "Target": {
	      "type": "object",
	      "required": ["fresh"],
	      "properties": {"fresh": {"type": "string", "pattern": "^[0-9]+$"}}
	    }
	  }
	}`, e2eSpec)

	if err := run(manifest); err != nil {
		t.Fatalf("run: %v", err)
	}
	got, err := os.ReadFile(specPath)
	if err != nil {
		t.Fatal(err)
	}
	out := string(got)

	if strings.Contains(out, "stale:") {
		t.Error("the previous body survived")
	}
	if !strings.Contains(out, "pattern: ^[0-9]+$") {
		t.Error("the declaration's constraint did not reach the spec")
	}
	if strings.Contains(out, "$schema") {
		t.Error("a declaration meta keyword leaked into the spec")
	}
	for _, keep := range []string{"    Before:\n      type: string", "    After:\n      type: string"} {
		if !strings.Contains(out, keep) {
			t.Errorf("neighbouring component disturbed: %q missing", keep)
		}
	}
}

func TestRunIsIdempotent(t *testing.T) {
	manifest, specPath := fixture(t, `{"$defs": {"Target": {"type": "object"}}}`, e2eSpec)
	if err := run(manifest); err != nil {
		t.Fatalf("first run: %v", err)
	}
	first, _ := os.ReadFile(specPath)
	if err := run(manifest); err != nil {
		t.Fatalf("second run: %v", err)
	}
	second, _ := os.ReadFile(specPath)
	if string(first) != string(second) {
		t.Error("a second run changed the spec again; generation is not idempotent")
	}
}

// A spec that could not be fully converted must not be written at all, or the repository
// would be left holding a half-translated contract.
func TestRunLeavesTheSpecUntouchedWhenConversionFails(t *testing.T) {
	manifest, specPath := fixture(t,
		`{"$defs": {"Target": {"type": ["string", "integer"]}}}`, e2eSpec)
	before, _ := os.ReadFile(specPath)

	err := run(manifest)
	if err == nil {
		t.Fatal("want an error for an unconvertible construct")
	}
	after, _ := os.ReadFile(specPath)
	if string(before) != string(after) {
		t.Error("the spec was modified despite the conversion failing")
	}
}

func TestRunReportsAMissingShape(t *testing.T) {
	manifest, _ := fixture(t, `{"$defs": {"Other": {"type": "object"}}}`, e2eSpec)
	err := run(manifest)
	if err == nil || !strings.Contains(err.Error(), "Target") {
		t.Errorf("want an error naming Target, got %v", err)
	}
}

// The dialect conversion drops keywords OpenAPI 3.0.3 cannot express. A declaration is
// already JSON Schema 2020-12, so running the conversion into one would quietly remove
// validation from a schema that signatures are checked against.
func TestDeclarationTargetsKeepKeywordsOpenAPICannotExpress(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("shared.json", `{
  "$defs": {
    "Target": {
      "type": "object",
      "properties": {
        "ctx": {
          "type": "array",
          "contains": { "const": "https://www.w3.org/2018/credentials/v1" }
        }
      }
    }
  }
}`)
	write("schema.json", `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "Target": {
      "type": "object"
    }
  }
}`)
	write("canonical-shapes.yaml",
		"target: schema.json\nsource: shared.json\nshapes:\n  - name: Target\n    from: $defs/Target\n")

	if err := run(filepath.Join(dir, "canonical-shapes.yaml")); err != nil {
		t.Fatalf("run: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	out := string(got)
	if !strings.Contains(out, `"contains"`) {
		t.Errorf("contains was stripped from a declaration:\n%s", out)
	}
	if !strings.Contains(out, `"const"`) {
		t.Errorf("const was rewritten to enum in a declaration:\n%s", out)
	}
	if strings.Contains(out, `"enum"`) {
		t.Errorf("the OpenAPI dialect conversion ran against a declaration:\n%s", out)
	}
}

// And the spec side must still be converted, or a spec would carry keywords its readers
// cannot parse.
func TestSpecTargetsStillGetTheDialectConversion(t *testing.T) {
	manifest, specPath := fixture(t,
		`{"$defs": {"Target": {"type": "object", "properties": {"v": {"const": "x"}}}}}`, e2eSpec)
	if err := run(manifest); err != nil {
		t.Fatalf("run: %v", err)
	}
	got, _ := os.ReadFile(specPath)
	if !strings.Contains(string(got), "enum:") {
		t.Errorf("const was not converted to enum for a spec target:\n%s", got)
	}
}

// Shapes are resolved out of one parsed source document. If a shape's node is handed to
// the remove/overlay pass without copying, that pass edits the source itself, and every
// later shape in the same run reads a tree that has already been altered. The target here
// is a declaration, which is the path that does not go through the converter's copy.
func TestOneShapeDoesNotMutateWhatAnotherReads(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Shared is the whole document; Inner is a member of it. Editing one must not reach
	// the other.
	write("shared.json", `{
  "$defs": {
    "Inner": {
      "type": "object",
      "properties": { "keepMe": { "type": "string" }, "dropMe": { "type": "string" } }
    }
  }
}`)
	write("schema.json", `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "First": {
      "type": "object"
    },
    "Second": {
      "type": "object"
    }
  }
}`)
	// Both shapes read the same definition; the first drops a property from its copy.
	write("canonical-shapes.yaml", `target: schema.json
source: shared.json
shapes:
  - name: First
    from: $defs/Inner
    reason: drops a property from its own copy only
    remove:
      - properties.dropMe
  - name: Second
    from: $defs/Inner
`)
	if err := run(filepath.Join(dir, "canonical-shapes.yaml")); err != nil {
		t.Fatalf("run: %v", err)
	}
	out, err := os.ReadFile(filepath.Join(dir, "schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Defs map[string]struct {
			Properties map[string]any `json:"properties"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("result is not valid JSON: %v\n%s", err, out)
	}
	if _, ok := doc.Defs["First"].Properties["dropMe"]; ok {
		t.Error("First kept a property its manifest removed")
	}
	if _, ok := doc.Defs["Second"].Properties["dropMe"]; !ok {
		t.Error("Second lost a property it never asked to remove: the first shape mutated the shared source")
	}
}

// An interrupted run must leave the previous content, not a half-written file.
func TestWriteIsAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "target.yaml")
	if err := os.WriteFile(path, []byte("original\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(path, []byte("replacement\n")); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "replacement\n" {
		t.Errorf("content = %q", got)
	}
	// No temporary files left behind for the drift guard to trip over.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("expected only the target to remain, found %v", names)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o644 {
		t.Errorf("mode = %v, want 0644", info.Mode().Perm())
	}
}
