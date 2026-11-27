package senderauth

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDeterministicPermitNonce(t *testing.T) {
	depositor := "0xAbC0000000000000000000000000000000000001"

	a, err := DeterministicPermitNonce("req_A", depositor)
	require.NoError(t, err)
	a2, err := DeterministicPermitNonce("req_A", depositor)
	require.NoError(t, err)
	require.Equal(t, a.String(), a2.String(), "stable for the same identity")

	b, err := DeterministicPermitNonce("req_B", depositor)
	require.NoError(t, err)
	require.NotEqual(t, a.String(), b.String(), "differs by request_id")

	c, err := DeterministicPermitNonce("req_A", "0xdEf")
	require.NoError(t, err)
	require.NotEqual(t, a.String(), c.String(), "differs by depositor")

	_, err = DeterministicPermitNonce("", depositor)
	require.ErrorContains(t, err, "request_id is required")
}

func TestDeterministicSolanaNonce(t *testing.T) {
	depositor := "DepositoR1111111111111111111111111111111111"

	n, err := DeterministicSolanaNonce("req_A", depositor)
	require.NoError(t, err)
	n2, err := DeterministicSolanaNonce("req_A", depositor)
	require.NoError(t, err)
	require.Equal(t, n, n2, "stable for the same identity")

	require.Less(t, n&0xFF, uint64(235), "slot (low byte) < 235")
	require.Less(t, n>>32, uint64(solanaReplayBuckets), "bucket is within the bounded set")
	require.Equal(t, uint64(0), (n>>8)&0xFFFFFF, "bits 8..31 unused (matches generateNonce layout)")

	m, err := DeterministicSolanaNonce("req_B", depositor)
	require.NoError(t, err)
	require.NotEqual(t, n, m, "differs by request_id")
}

// TestGenerateValidSolanaNonce: every random Solana nonce must land a valid on-chain replay slot
// (< 235, never the reserved 235-255 range) and a bucket inside the bounded set. The conformance
// vectors cover only the deterministic nonce.
func TestGenerateValidSolanaNonce(t *testing.T) {
	for i := 0; i < 10000; i++ {
		n := generateValidSolanaNonce()
		require.Less(t, n&0xFF, uint64(solanaReplaySlots), "slot (low byte) < 235")
		require.Less(t, n>>32, uint64(solanaReplayBuckets), "bucket is within the bounded set")
		require.Equal(t, uint64(0), (n>>8)&0xFFFFFF, "bits 8..31 unused (matches generateNonce layout)")
	}
}
