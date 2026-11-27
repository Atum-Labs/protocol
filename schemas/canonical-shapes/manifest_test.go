package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func writeManifest(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "canonical-shapes.yaml")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadManifest(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantErr string
	}{
		{
			name: "a complete manifest loads",
			body: "target: openapi.yaml\nsource: ../d/schema.json\nshapes:\n  - name: A\n    from: $defs/A\n",
		},
		{
			name:    "target is required",
			body:    "source: ../d/schema.json\nshapes:\n  - name: A\n    from: $defs/A\n",
			wantErr: "'target' is required",
		},
		{
			name:    "a target that is neither a spec nor a declaration is rejected",
			body:    "target: notes.txt\nsource: ../d/schema.json\nshapes:\n  - name: A\n    from: $defs/A\n",
			wantErr: "must be an OpenAPI .yaml or a declaration .json",
		},
		{
			name:    "source is required",
			body:    "target: openapi.yaml\nshapes:\n  - name: A\n    from: $defs/A\n",
			wantErr: "'source' is required",
		},
		{
			name:    "a manifest generating nothing is a mistake, not a no-op",
			body:    "target: openapi.yaml\nsource: ../d/schema.json\nshapes: []\n",
			wantErr: "no shapes listed",
		},
		{
			name:    "a shape needs both fields",
			body:    "target: openapi.yaml\nsource: ../d/schema.json\nshapes:\n  - name: A\n",
			wantErr: "needs both 'name' and 'from'",
		},
		{
			name:    "a duplicate name would silently generate twice",
			body:    "target: openapi.yaml\nsource: ../d/schema.json\nshapes:\n  - name: A\n    from: $defs/A\n  - name: A\n    from: $defs/B\n",
			wantErr: "listed twice",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := LoadManifest(writeManifest(t, tc.body))
			switch {
			case tc.wantErr == "" && err != nil:
				t.Fatalf("unexpected error: %v", err)
			case tc.wantErr != "" && err == nil:
				t.Fatalf("want error containing %q, got nil", tc.wantErr)
			case tc.wantErr != "" && !strings.Contains(err.Error(), tc.wantErr):
				t.Errorf("error %q does not contain %q", err, tc.wantErr)
			}
		})
	}
}

func TestManifestPathsResolveRelativeToTheManifest(t *testing.T) {
	path := writeManifest(t, "target: openapi.yaml\nsource: ../../declarations/X/v1/schema.json\nshapes:\n  - name: A\n    from: $defs/A\n")
	m, err := LoadManifest(path)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(path)
	if got, want := m.TargetPath(), filepath.Join(dir, "openapi.yaml"); got != want {
		t.Errorf("TargetPath() = %q, want %q", got, want)
	}
	if got, want := m.SourcePath(), filepath.Join(dir, "../../declarations/X/v1/schema.json"); got != want {
		t.Errorf("SourcePath() = %q, want %q", got, want)
	}
}

func TestResolve(t *testing.T) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(`{"type":"object","$defs":{"Inner":{"type":"string"}}}`), &doc); err != nil {
		t.Fatal(err)
	}
	t.Run("the root", func(t *testing.T) {
		n, err := resolve(&doc, ".")
		if err != nil {
			t.Fatal(err)
		}
		if mappingValue(n, "type").Value != "object" {
			t.Error("'.' did not resolve to the declaration root")
		}
	})
	t.Run("a named def", func(t *testing.T) {
		n, err := resolve(&doc, "$defs/Inner")
		if err != nil {
			t.Fatal(err)
		}
		if mappingValue(n, "type").Value != "string" {
			t.Error("$defs/Inner did not resolve")
		}
	})
	t.Run("a missing def names itself", func(t *testing.T) {
		_, err := resolve(&doc, "$defs/Nope")
		if err == nil || !strings.Contains(err.Error(), "$defs/Nope") {
			t.Errorf("want an error naming $defs/Nope, got %v", err)
		}
	})
	t.Run("an unsupported pointer is rejected", func(t *testing.T) {
		_, err := resolve(&doc, "#/components/schemas/X")
		if err == nil || !strings.Contains(err.Error(), "unsupported pointer") {
			t.Errorf("want an unsupported-pointer error, got %v", err)
		}
	})
}
