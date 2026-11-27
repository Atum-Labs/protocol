package senderauth

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// requiredCommitmentVectors is the shared fixture at
// PaymentRequest/v1/conformance/required-commitment-vectors.json. It is written by hand, not
// recorded, so it is the oracle for both implementations.
type requiredCommitmentVectors struct {
	Comment string `json:"_comment"`
	Vectors []struct {
		Name         string              `json:"name"`
		Request      string              `json:"request"`
		Solana       *SolanaDomain       `json:"solana"`
		TronChainIDs map[string]int64    `json:"tronChainIds"`
		Want         *RequiredCommitment `json:"want"`
		Result       *CommitmentResult   `json:"result"`
	} `json:"vectors"`
}

func readRequiredCommitmentVectors(t *testing.T) requiredCommitmentVectors {
	t.Helper()
	raw, err := os.ReadFile(conformancePath("required-commitment-vectors.json"))
	require.NoError(t, err)
	var v requiredCommitmentVectors
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	require.NoError(t, dec.Decode(&v))
	require.NotEmpty(t, v.Vectors)
	return v
}

// The shared vectors the TypeScript suite also asserts. Mirrors TS required-commitment.test.ts.
func TestRequiredCommitmentVectors(t *testing.T) {
	v := readRequiredCommitmentVectors(t)
	names := map[string]bool{}
	ran := 0
	for _, c := range v.Vectors {
		require.False(t, names[c.Name], "%s names two vectors", c.Name)
		names[c.Name] = true
		require.True(t, (c.Want == nil) != (c.Result == nil), "%s expects exactly one of want and result", c.Name)
		t.Run(c.Name, func(t *testing.T) {
			ran++
			// With a prehash, or unreadable, the vector is VerifyRequestCommitment's answer for the
			// same request and domain.
			_, deposit, _, _, readErr := readRequest([]byte(c.Request))
			if readErr != nil || (len(deposit.SignedMessages) > 0 && deposit.SignedMessages[0].MessagePrehash != nil) {
				verified, verifyErr := VerifyRequestCommitment([]byte(c.Request), c.Solana, WithTronChainIDs(c.TronChainIDs))
				if c.Want != nil {
					require.NoError(t, verifyErr)
					assert.Equal(t, *c.Want, RequiredCommitment{
						Namespace:          verified.Namespace,
						Destination:        verified.ExpectedDestination,
						DepositRequestHash: verified.ExpectedDepositRequestHash,
					}, "the commitment VerifyRequestCommitment compared")
				} else {
					assert.Equal(t, *c.Result, verified, "the result VerifyRequestCommitment returns")
				}
			}
			got, err := RequiredCommitmentOf([]byte(c.Request), c.Solana, WithTronChainIDs(c.TronChainIDs))
			if c.Want != nil {
				require.NoError(t, err)
				assert.Equal(t, *c.Want, got)
				return
			}
			var ce *CommitmentError
			require.True(t, errors.As(err, &ce), "a refusal returns a *CommitmentError")
			assert.Equal(t, RequiredCommitment{}, got, "a refusal returns no commitment")
			result, ok := CommitmentResultOf(err)
			require.True(t, ok)
			assert.Equal(t, *c.Result, result, "Go and TypeScript must return the same result")
		})
	}
	// Every vector ran, unless -run picked some out.
	if flag.Lookup("test.run").Value.String() == "" {
		require.Equal(t, len(v.Vectors), ran, "every vector ran")
	}
}

// On every commitment vector whose request carries a signed prehash, or cannot be read,
// RequiredCommitmentOf is VerifyRequestCommitment: the commitment compared when verified, the same
// refusal otherwise. On every other request no signed commitment can be read, and VerifyRequestCommitment could
// only find no commitment. Mirrors the TS test of the same name.
func TestRequiredCommitmentOfMatchesComparison(t *testing.T) {
	raw, err := os.ReadFile(conformancePath("commitment-vectors.json"))
	require.NoError(t, err)
	var v commitmentVectors
	require.NoError(t, json.Unmarshal(raw, &v))
	// The unsigned rows are an honest payment with its prehash, or its whole sender_auth, removed, so
	// the commitment they require is the one the honest payment of the same chain family was verified
	// against.
	honest := map[string]RequiredCommitment{}
	for _, c := range v.Requests {
		if strings.HasSuffix(c.Name, "-honest") {
			honest[strings.TrimSuffix(c.Name, "-honest")] = RequiredCommitment{
				Namespace:          c.Result.Namespace,
				Destination:        c.Result.ExpectedDestination,
				DepositRequestHash: c.Result.ExpectedDepositRequestHash,
			}
		}
	}
	invalidDomain := &SolanaDomain{EscrowProgramID: "not-base58!", ClusterID: "devnet", DomainVersion: 5}
	signed, unsigned := 0, 0
	for _, c := range v.Requests {
		_, deposit, _, _, readErr := readRequest([]byte(c.Request))
		carriesPrehash := readErr == nil && len(deposit.SignedMessages) > 0 && deposit.SignedMessages[0].MessagePrehash != nil
		// An unsigned row's Tron chain ids are for VerifyRequestCommitment, which reports the missing
		// signed messages before it reads them. The unsigned path here reads them for the
		// supported-chain rule, which required-commitment-vectors.json pins, so it is given none.
		tronChainIDs := c.TronChainIDs
		if readErr != nil || carriesPrehash {
			signed++
		} else {
			unsigned++
			tronChainIDs = nil
		}
		t.Run(c.Name, func(t *testing.T) {
			got, err := RequiredCommitmentOf([]byte(c.Request), c.Solana, WithTronChainIDs(tronChainIDs))
			if readErr != nil || carriesPrehash {
				if c.Result.Outcome == OutcomeVerified {
					require.NoError(t, err)
					assert.Equal(t, RequiredCommitment{
						Namespace:          c.Result.Namespace,
						Destination:        c.Result.ExpectedDestination,
						DepositRequestHash: c.Result.ExpectedDepositRequestHash,
					}, got)
					return
				}
				result, ok := CommitmentResultOf(err)
				require.True(t, ok, "a refusal carries a result")
				assert.Equal(t, RequiredCommitment{}, got)
				assert.Equal(t, c.Result, result)
				return
			}
			assert.Equal(t, OutcomeCommitmentAbsent, c.Result.Outcome)
			family, _, _ := strings.Cut(c.Name, "-")
			want, ok := honest[family]
			require.True(t, ok, "no honest payment for %q", family)
			require.NoError(t, err)
			assert.Equal(t, want, got)
			// No signed commitment can be read, so the Solana domain is never read: none, or an invalid one,
			// changes nothing.
			for _, domain := range []*SolanaDomain{nil, invalidDomain} {
				again, againErr := RequiredCommitmentOf([]byte(c.Request), domain, WithTronChainIDs(tronChainIDs))
				require.NoError(t, againErr)
				assert.Equal(t, want, again)
			}
		})
	}
	require.NotZero(t, signed, "no commitment vector carries a signed prehash")
	require.NotZero(t, unsigned, "no commitment vector is unsigned")
}

// Bytes that are not valid UTF-8 are refused, as they are in TypeScript. Mirrors the TS test.
func TestRequiredCommitmentOfBytes(t *testing.T) {
	var honest string
	for _, c := range readRequiredCommitmentVectors(t).Vectors {
		if c.Name == "eip155-unsigned" {
			honest = c.Request
		}
	}
	require.NotEmpty(t, honest)

	invalid := append(append([]byte(`{"note":"`), 0xff), []byte(`",`+honest[1:])...)
	_, err := RequiredCommitmentOf(invalid, nil)
	requireCommitmentOutcome(t, err, OutcomeRequestMalformed)
	r, _ := CommitmentResultOf(err)
	require.Equal(t, "the payment request is not a single valid JSON document", r.Detail)
}
