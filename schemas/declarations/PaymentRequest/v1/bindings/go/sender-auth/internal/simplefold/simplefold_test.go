package simplefold

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// The committed TypeScript table must be exactly what this toolchain's Unicode tables generate, so
// the two languages fold member names identically.
func TestTypeScriptTableIsUpToDate(t *testing.T) {
	committed, err := os.ReadFile(filepath.Join("..", "..", TypeScriptFile))
	require.NoError(t, err)
	require.Equal(t, TypeScript(), string(committed),
		"simple-fold.gen.ts is stale: run `go run ./cmd/gen-simple-fold` in bindings/go/sender-auth")
}
