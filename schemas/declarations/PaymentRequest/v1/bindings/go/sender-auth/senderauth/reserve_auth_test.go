package senderauth

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// reserveAuthVectors is the shared fixture at PaymentRequest/v1/conformance/reserve-auth-vectors.json.
type reserveAuthVectors struct {
	Comment string            `json:"_comment"`
	Signers map[string]string `json:"signers"`
	Vectors []struct {
		Name    string `json:"name"`
		Comment string `json:"_comment"`
		Input   struct {
			Auth     ReserveAuth             `json:"auth"`
			Expected ReserveAuthExpectations `json:"expected"`
		} `json:"input"`
		Offline bool              `json:"offline"`
		Chain   *fakeChain        `json:"chain"`
		Result  ReserveAuthResult `json:"result"`
		Calls   []checkerCall     `json:"calls"`
	} `json:"vectors"`
}

func readReserveAuthVectors(t *testing.T) reserveAuthVectors {
	t.Helper()
	raw, err := os.ReadFile(conformancePath("reserve-auth-vectors.json"))
	require.NoError(t, err)
	var v reserveAuthVectors
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	require.NoError(t, dec.Decode(&v))
	require.NotEmpty(t, v.Vectors)
	return v
}

// The shared vectors the TypeScript suite also asserts. Mirrors TS reserve-auth.test.ts.
func TestReserveAuthVectors(t *testing.T) {
	v := readReserveAuthVectors(t)
	names := map[string]bool{}
	ran := 0
	for _, c := range v.Vectors {
		require.False(t, names[c.Name], "%s names two vectors", c.Name)
		names[c.Name] = true
		t.Run(c.Name, func(t *testing.T) {
			ran++
			var checker DepositorSignatureChecker
			fake := &fakeChecker{}
			if c.Chain != nil {
				fake.chain = *c.Chain
			}
			if !c.Offline {
				checker = fake
			}
			got := VerifyReserveAuth(context.Background(), c.Input.Auth, c.Input.Expected, checker)
			assert.Equal(t, c.Result, got, "Go and TypeScript must return the same result")
			want := c.Calls
			if want == nil {
				want = []checkerCall{}
			}
			if fake.calls == nil {
				fake.calls = []checkerCall{}
			}
			assert.Equal(t, want, fake.calls, "the checker calls, in order")
		})
	}
	if flag.Lookup("test.run").Value.String() == "" {
		require.Equal(t, len(v.Vectors), ran, "every vector ran")
	}
}

// Every field of the reserve witness has a refusal of its own on every chain, from the prehash and
// from the expectations.
func TestReserveAuthVectorsCoverEveryFieldPerChain(t *testing.T) {
	v := readReserveAuthVectors(t)
	names := map[string]ReserveAuthReason{}
	for _, c := range v.Vectors {
		names[c.Name] = c.Result.Reason
	}
	for _, chain := range []string{"evm", "tron"} {
		for field, reason := range map[string]ReserveAuthReason{
			"depositId": ReserveReasonDepositIDMismatch, "quoteHash": ReserveReasonQuoteHashMismatch,
			"settler": ReserveReasonSettlerMismatch, "sourceAmount": ReserveReasonSourceAmountMismatch,
		} {
			assert.Equal(t, reason, names[chain+"-prehash-"+field+"-tampered"], "%s %s prehash", chain, field)
			assert.Equal(t, reason, names[chain+"-expected-"+field+"-differs"], "%s %s expected", chain, field)
		}
		assert.Equal(t, ReserveReasonMessageMismatch, names[chain+"-message-for-another-settler"], chain)
		assert.Equal(t, ReserveReasonSignerMismatch, names[chain+"-signed-by-another-key"], chain)
	}
	for field, reason := range map[string]ReserveAuthReason{
		"depositId": ReserveReasonDepositIDMismatch, "quoteHash": ReserveReasonQuoteHashMismatch,
		"settler": ReserveReasonSettlerMismatch, "sourceAmount": ReserveReasonSourceAmountMismatch,
	} {
		assert.Equal(t, reason, names["solana-record-"+field+"-tampered"], "solana %s record", field)
		assert.Equal(t, reason, names["solana-expected-"+field+"-differs"], "solana %s expected", field)
	}
	assert.Equal(t, ReserveReasonMessageMismatch, names["solana-message-for-another-settler"])
	assert.Equal(t, ReserveReasonSignerMismatch, names["solana-signed-by-another-key"])
}

// The Solana vectors sign the frozen V5 reserve anchor that the encoders and the program pin
// (contracts/svm/bindings/go/escrow-encoding/encoding/v3_sourceamount_test.go).
func TestReserveAuthSolanaAnchorIsTheFrozenV5Hash(t *testing.T) {
	for _, c := range readReserveAuthVectors(t).Vectors {
		if c.Name == "solana-verified" {
			assert.Equal(t, "0xd9f194eb2cdbbb060453ee08633a736adbbdb5efd7bf680de0997b18b145daf4", c.Input.Auth.Message)
			return
		}
	}
	t.Fatal("solana-verified is not in the fixture")
}

// The EVM anchor is the reserve the Foundry test runs through the real escrow.
func TestReserveAuthEVMAnchorIsTheContractBoundVector(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "..", "..", "..", "contracts", "evm", "conformance", "direct-deposit-vectors.json"))
	require.NoError(t, err)
	var dd struct {
		ChainID   int64  `json:"chainID"`
		Escrow    string `json:"escrow"`
		DepositID string `json:"depositId"`
		Reserve   struct {
			QuoteHash        string `json:"quoteHash"`
			Settler          string `json:"settler"`
			SourceAmount     string `json:"sourceAmount"`
			ReserveSignature string `json:"reserveSignature"`
		} `json:"reserve"`
	}
	require.NoError(t, json.Unmarshal(raw, &dd))
	v := readReserveAuthVectors(t)
	for _, c := range v.Vectors {
		if c.Name != "evm-eoa-verified" {
			continue
		}
		e := c.Input.Expected
		assert.Equal(t, "eip155:31337", e.Network)
		assert.Equal(t, int64(31337), dd.ChainID)
		assert.True(t, strings.EqualFold(dd.Escrow, e.EscrowContract))
		assert.Equal(t, dd.DepositID, e.DepositID)
		assert.Equal(t, dd.Reserve.QuoteHash, e.QuoteHash)
		assert.True(t, strings.EqualFold(dd.Reserve.Settler, e.Settler))
		assert.Equal(t, dd.Reserve.SourceAmount, e.SourceAmount)
		assert.Equal(t, dd.Reserve.ReserveSignature, c.Input.Auth.Signature)
		return
	}
	t.Fatal("evm-eoa-verified is not in the fixture")
}

// The two length cases the fixture leaves to the suites, on evm-contract-magic-verified: a signature
// exactly the depositor rule's bound is passed through whole, one a byte longer is refused before
// any chain read. Mirrors the TS "the signature length bound".
func TestReserveAuthSignatureLengthBound(t *testing.T) {
	bound := readDepositorSignatureVectors(t).SignatureMaxLength
	v := readReserveAuthVectors(t)
	i := -1
	for j, c := range v.Vectors {
		if c.Name == "evm-contract-magic-verified" {
			i = j
		}
	}
	require.GreaterOrEqual(t, i, 0)
	base := v.Vectors[i]
	atBound := "0x" + strings.Repeat("ab", (bound-2)/2)

	fake := &fakeChecker{chain: *base.Chain}
	auth := base.Input.Auth
	auth.Signature = atBound
	got := VerifyReserveAuth(context.Background(), auth, base.Input.Expected, fake)
	assert.Equal(t, ReserveReasonVerified, got.Reason)
	require.Len(t, fake.calls, 2)
	assert.Equal(t, atBound, fake.calls[1].Signature)

	fake = &fakeChecker{chain: *base.Chain}
	auth.Signature = atBound + "ab"
	got = VerifyReserveAuth(context.Background(), auth, base.Input.Expected, fake)
	assert.Equal(t, ReserveAuthResult{Path: PathNone, Reason: ReserveReasonMalformed, Detail: "the signature is longer than 65536 characters"}, got)
	assert.Empty(t, fake.calls)
}
