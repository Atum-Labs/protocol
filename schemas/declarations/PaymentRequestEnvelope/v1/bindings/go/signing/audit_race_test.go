package signing

import (
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

// The parsed context is a package-level value shared by every call and handed to the JSON-LD
// processor. If anything mutated it during canonicalization, concurrent producers would
// corrupt each other's envelopes — and a payment gateway signs concurrently by definition.
//
// Comparing output bytes only catches a mutation that changes EVERY envelope. A genuine data
// race on the shared map passes 99 runs in 100 and then crashes a producer with "concurrent map
// read and map write", so this test is only worth its name under `go test -race` — which the
// signing modules now run in CI.
func TestConcurrentBuildEnvelopeIsRaceFree(t *testing.T) {
	const n = 24
	out := make([][]byte, n)
	// Errors are collected and asserted AFTER Wait, never inside the goroutine. require.NoError
	// calls t.FailNow, which Go documents as legal only on the test's own goroutine; from a
	// worker it Goexits that worker instead, leaving out[i] nil and surfacing as a confusing
	// byte-mismatch below rather than as the real error.
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			env, err := BuildEnvelope(acceptanceOptions(t))
			errs[i], out[i] = err, env
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		require.NoErrorf(t, err, "BuildEnvelope failed on goroutine %d", i)
	}
	for i := 1; i < n; i++ {
		require.Equal(t, string(out[0]), string(out[i]),
			"concurrent builds must be byte-identical; a difference means shared state was mutated")
	}
}

// ParsedContext hands the context to verifiers. If it returned the package's own value, a
// caller mutating it would change what this package signs for every later envelope — and the
// requester gateway holds this same value as its loader overlay, so both halves would move
// at once, silently, with only the signature differing.
func TestParsedContextIsIndependentOfTheSigner(t *testing.T) {
	ctx, err := ParsedContext()
	require.NoError(t, err)

	before, err := BuildEnvelope(acceptanceOptions(t))
	require.NoError(t, err)

	m, ok := ctx.(map[string]any)
	require.True(t, ok, "unexpected context shape %T", ctx)
	m["@context"] = map[string]any{"evil": "https://attacker.example/#evil"}

	after, err := BuildEnvelope(acceptanceOptions(t))
	require.NoError(t, err)
	require.Equal(t, string(before), string(after),
		"mutating what ParsedContext returned must not change what this package signs")

	// And a second call must not see the first caller's mutation either.
	fresh, err := ParsedContext()
	require.NoError(t, err)
	freshMap, ok := fresh.(map[string]any)
	require.True(t, ok)
	require.NotContains(t, freshMap["@context"], "evil",
		"each caller must get its own copy")
}
