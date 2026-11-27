package main

import (
	"os"
	"path/filepath"
	"testing"
)

// A TypeScript compiler config is JSONC, not JSON: tsc accepts comments in it, and the
// publishable SDKs under apis/*/v1/bindings/ rely on that to explain their configs. The
// walker must not reject it as invalid JSON.
func TestValidateJSONFileSkipsTSConfig(t *testing.T) {
	jsonc := "// why this config exists\n{\n  // and why this key\n  \"extends\": \"./tsconfig.json\"\n}\n"
	for _, name := range []string{"tsconfig.json", "tsconfig.test.json"} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), name)
			if err := os.WriteFile(path, []byte(jsonc), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := validateJSONFile(path); err != nil {
				t.Fatalf("validateJSONFile(%s) = %v, want nil", name, err)
			}
		})
	}
}

// The tsconfig exemption is by file name, so it must not leak to other JSON: a schema or
// fixture with a comment in it is still broken.
func TestValidateJSONFileStillRejectsCommentsElsewhere(t *testing.T) {
	for _, name := range []string{"schema.json", "tsconfig-shapes.schema.json", "not-a-tsconfig.json"} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), name)
			if err := os.WriteFile(path, []byte("// nope\n{}\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := validateJSONFile(path); err == nil {
				t.Fatalf("validateJSONFile(%s) = nil, want an invalid-JSON error", name)
			}
		})
	}
}
