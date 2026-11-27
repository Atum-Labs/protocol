package signing

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

var updateGolden = flag.Bool("update-golden", false, "rewrite the golden envelope from current output")

// The golden bytes were checked byte-equal to the implementation this replaced, while both
// still existed. Pinning them turns that one-time equality into a standing guard, so the
// reference survives the original being deleted.
//
// Why bytes and not just a well-formed-envelope check: proof.challenge and the holder
// signature are computed over these bytes, and the gateway recomputes them. A
// change that reorders a key or adjusts the context emits a perfectly valid-looking envelope
// that no longer verifies — and it would break every envelope built after the change, not
// just new tests.
//
// If this fails and the change is intended, confirm the wire consequence first, then
// regenerate with:
//
//	go test ./... -run TestBuildEnvelope_MatchesTheGoldenBytes -update-golden
func TestBuildEnvelope_MatchesTheGoldenBytes(t *testing.T) {
	out, err := BuildEnvelope(testOptions(t))
	require.NoError(t, err)

	path := filepath.Join("testdata", "envelope-golden.json")
	if *updateGolden {
		require.NoError(t, os.WriteFile(path, out, 0o644))
		t.Log("golden rewritten")
		return
	}

	want, err := os.ReadFile(path)
	require.NoError(t, err, "read the golden envelope")
	require.Equal(t, string(want), string(out),
		"the envelope bytes changed. Every envelope built after this change carries a "+
			"signature over different bytes than the golden one, so confirm the wire "+
			"consequence before regenerating.")
}

// The inner document is the other half of the pair the verifier cross-checks, so it is pinned
// for the same reason.
func TestSignInnerPaymentRequest_MatchesTheGoldenBytes(t *testing.T) {
	out, err := SignInnerPaymentRequest(testOptions(t))
	require.NoError(t, err)

	path := filepath.Join("testdata", "inner-request-golden.json")
	if *updateGolden {
		require.NoError(t, os.WriteFile(path, out, 0o644))
		return
	}

	want, err := os.ReadFile(path)
	require.NoError(t, err, "read the golden inner request")
	require.Equal(t, string(want), string(out))
}

// Guards the golden files themselves: a truncated or hand-edited fixture would make the
// comparisons above pass for the wrong reason.
func TestGoldenFilesAreWellFormedEnvelopes(t *testing.T) {
	for _, name := range []string{"envelope-golden.json", "inner-request-golden.json"} {
		raw, err := os.ReadFile(filepath.Join("testdata", name))
		require.NoError(t, err)
		var doc map[string]any
		require.NoError(t, json.Unmarshal(raw, &doc), "%s must be a JSON object", name)
		require.Contains(t, doc, "proof", "%s must carry a proof", name)
	}
}
