package paymentrequestenvelope

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// The embedded snapshot must equal the canonical context. It is a copy, kept here because
// go:embed cannot reach outside its package directory, and it is what every signature is
// computed over — so a stale one changes signatures silently.
//
// The Makefile's verify-context gates this in CI; asserting it from the test suite too means it
// also runs for anyone who skips make.
func TestEmbeddedContextMatchesTheCanonicalSource(t *testing.T) {
	canonical, err := os.ReadFile(filepath.Join("..", "..", "context.jsonld"))
	require.NoError(t, err, "read the canonical PRE context")
	require.Equal(t, string(canonical), string(embeddedContext),
		"the embedded snapshot has drifted from the canonical context; run "+
			"'make -C schemas/declarations/PaymentRequestEnvelope/v1/bindings/go update-context'")
}

// ParsedContext must hand out an independent copy every call. If it returned a package-level
// value, a caller mutating it — or a library doing so — would change what every later signature
// in the process is computed over, silently, because the document still looks right and only
// the signed bytes differ.
func TestParsedContextIsIndependentPerCall(t *testing.T) {
	first, err := ParsedContext()
	require.NoError(t, err)
	second, err := ParsedContext()
	require.NoError(t, err)

	m, ok := first.(map[string]any)
	require.True(t, ok, "unexpected context shape %T", first)
	m["$comment"] = "mutated by a caller"

	n, ok := second.(map[string]any)
	require.True(t, ok)
	require.NotEqual(t, "mutated by a caller", n["$comment"],
		"mutating one ParsedContext result changed another; the accessor is aliasing its source")

	third, err := ParsedContext()
	require.NoError(t, err)
	t3, ok := third.(map[string]any)
	require.True(t, ok)
	require.NotEqual(t, "mutated by a caller", t3["$comment"],
		"a later call inherited an earlier caller's mutation")
}
