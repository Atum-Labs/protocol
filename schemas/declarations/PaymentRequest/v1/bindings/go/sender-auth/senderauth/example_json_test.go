package senderauth

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// The readme tells integrators to copy example.json, so it must pass every check a verifier runs.
func TestExampleJSONVerifies(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "example.json"))
	require.NoError(t, err)

	r, err := VerifyRequestCommitment(raw, nil)
	require.NoError(t, err)
	require.True(t, r.Verified())

	now := 1700000000
	result, err := VerifyPaymentRequestJSON(raw, VerifyPaymentRequestExpectations{Expectations: Expectations{NowSec: &now}})
	require.NoError(t, err)
	require.Len(t, result.Results, 1)
	require.Equal(t, "1000001", result.Results[0].Amount)
}
