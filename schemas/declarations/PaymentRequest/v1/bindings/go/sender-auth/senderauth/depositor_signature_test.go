package senderauth

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// depositorSignatureVectors is the shared fixture at
// PaymentRequest/v1/conformance/depositor-signature-vectors.json. It is written by hand, not
// recorded, so it is the oracle for both implementations.
type depositorSignatureVectors struct {
	Comment string            `json:"_comment"`
	Signers map[string]string `json:"signers"`
	// SignatureMaxLength is the longest signature the rule reads, in characters with the 0x.
	SignatureMaxLength int               `json:"signatureMaxLength"`
	Digests            map[string]string `json:"digests"`
	Vectors            []struct {
		Name    string                   `json:"name"`
		Comment string                   `json:"_comment"`
		Input   DepositorSignature       `json:"input"`
		Offline bool                     `json:"offline"`
		Chain   *fakeChain               `json:"chain"`
		Result  DepositorSignatureResult `json:"result"`
		Calls   []checkerCall            `json:"calls"`
	} `json:"vectors"`
}

// fakeChain is the one account the fake checker models. See the fixture's _comment.
type fakeChain struct {
	Code             string `json:"code"`
	IsValidSignature *struct {
		ReturnData string `json:"returnData"`
		Reverts    bool   `json:"reverts"`
		OnlyCaller string `json:"onlyCaller"`
	} `json:"isValidSignature"`
	Unavailable string `json:"unavailable"`
}

// checkerCall is one call the fake checker received, with its arguments in hex.
type checkerCall struct {
	Method    string `json:"method"`
	Network   string `json:"network"`
	Account   string `json:"account"`
	Digest    string `json:"digest,omitempty"`
	Signature string `json:"signature,omitempty"`
	Caller    string `json:"caller,omitempty"`
}

var errChainUnavailable = errors.New("the chain is unavailable")

// fakeChecker answers from a fakeChain and records every call. Mirrors the TS fake checker.
type fakeChecker struct {
	chain fakeChain
	calls []checkerCall
}

func (f *fakeChecker) HasCode(_ context.Context, network, account string) (bool, error) {
	f.calls = append(f.calls, checkerCall{Method: "hasCode", Network: network, Account: account})
	if f.chain.Unavailable == "hasCode" {
		return false, errChainUnavailable
	}
	return f.chain.Code != "" && f.chain.Code != "0x", nil
}

func (f *fakeChecker) IsValidSignatureFrom(_ context.Context, network, account string, digest [32]byte, signature []byte, caller string) (ContractSignatureAnswer, error) {
	f.calls = append(f.calls, checkerCall{
		Method: "isValidSignatureFrom", Network: network, Account: account,
		Digest: "0x" + hex.EncodeToString(digest[:]), Signature: "0x" + hex.EncodeToString(signature), Caller: caller,
	})
	if f.chain.Unavailable == "isValidSignatureFrom" {
		return ContractSignatureAnswer{}, errChainUnavailable
	}
	answer := f.chain.IsValidSignature
	switch {
	case f.chain.Code == "" || f.chain.Code == "0x" || answer == nil:
		// eth_call to an account with no code succeeds and returns nothing.
		return ContractSignatureAnswer{}, nil
	case answer.Reverts:
		return ContractSignatureAnswer{Reverted: true}, nil
	case answer.OnlyCaller != "" && caller != answer.OnlyCaller:
		failure, _ := hex.DecodeString("ffffffff" + strings.Repeat("0", 56))
		return ContractSignatureAnswer{ReturnData: failure}, nil
	}
	data, err := hexToBytes(answer.ReturnData)
	if err != nil {
		return ContractSignatureAnswer{}, err
	}
	return ContractSignatureAnswer{ReturnData: data}, nil
}

func readDepositorSignatureVectors(t *testing.T) depositorSignatureVectors {
	t.Helper()
	raw, err := os.ReadFile(conformancePath("depositor-signature-vectors.json"))
	require.NoError(t, err)
	var v depositorSignatureVectors
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	require.NoError(t, dec.Decode(&v))
	require.NotEmpty(t, v.Vectors)
	return v
}

// The shared vectors the TypeScript suite also asserts. Mirrors TS depositor-signature.test.ts.
func TestDepositorSignatureVectors(t *testing.T) {
	v := readDepositorSignatureVectors(t)
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
			got := VerifyDepositorSignature(context.Background(), c.Input, checker)
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
	// Every vector ran, unless -run picked some out.
	if flag.Lookup("test.run").Value.String() == "" {
		require.Equal(t, len(v.Vectors), ran, "every vector ran")
	}
}

// Every EOA-path vector's signature, recovered alone: RecoverPermit2EOA returns the signer the
// vector's verdict implies, or wraps ErrRecoveryFailed with the reason its detail names.
func TestRecoverPermit2EOAAgreesWithTheVectors(t *testing.T) {
	v := readDepositorSignatureVectors(t)
	checked := 0
	for _, c := range v.Vectors {
		if c.Result.Path != PathEOA || c.Input.Network == "" {
			continue
		}
		checked++
		signer, err := RecoverPermit2EOA(c.Input.Digest, c.Input.Signature)
		switch {
		case c.Result.Valid:
			require.NoError(t, err, c.Name)
			account, ok := depositorAddress(namespaceOf(c.Input.Network), c.Input.Account)
			require.True(t, ok, c.Name)
			assert.True(t, strings.EqualFold(account, signer), "%s: recovered %s", c.Name, signer)
		case strings.HasPrefix(c.Result.Detail, "no signer recovers"):
			require.ErrorIs(t, err, ErrRecoveryFailed, c.Name)
			reason := strings.TrimSuffix(strings.TrimPrefix(c.Result.Detail, "no signer recovers from the signature ("), "), and the account has no code")
			assert.Equal(t, ErrRecoveryFailed.Error()+": "+reason, err.Error(), c.Name)
		default:
			require.NoError(t, err, c.Name)
			want := strings.TrimSuffix(strings.TrimPrefix(c.Result.Detail, "the signature recovers to "), ", and the account has no code")
			assert.Equal(t, want, signer, c.Name)
		}
	}
	require.Greater(t, checked, 10, "the vectors carry EOA-path cases")
}

// The two length cases the fixture leaves to the suites, on contract-magic-verified's account and
// chain: a signature exactly signatureMaxLength characters long is passed through whole, and one a
// byte longer is refused before any chain read. Mirrors the TS "the signature length bound".
func TestDepositorSignatureLengthBound(t *testing.T) {
	v := readDepositorSignatureVectors(t)
	require.Equal(t, 65536, v.SignatureMaxLength, "the veri-fill route's maxLength")
	i := -1
	for j, c := range v.Vectors {
		if c.Name == "contract-magic-verified" {
			i = j
		}
	}
	require.GreaterOrEqual(t, i, 0, "contract-magic-verified is in the fixture")
	base := v.Vectors[i]

	atBound := "0x" + strings.Repeat("ab", (v.SignatureMaxLength-2)/2)
	overBound := atBound + "ab"
	for _, c := range []struct {
		name      string
		signature string
		want      DepositorSignatureResult
		calls     []checkerCall
	}{
		{
			name:      "at the bound",
			signature: atBound,
			want:      DepositorSignatureResult{Valid: true, Path: PathContract, Reason: ReasonVerified, Detail: "isValidSignature returned the ERC-1271 magic value"},
			calls: []checkerCall{
				{Method: "hasCode", Network: "eip155:42161", Account: "0x5afe00000000000000000000000000000000c0de"},
				{Method: "isValidSignatureFrom", Network: "eip155:42161", Account: "0x5afe00000000000000000000000000000000c0de",
					Digest: "0x143abd003825e8e8af0671290b4aba3461a06de60edf06c4a9e8371fcaa84e3a", Signature: atBound, Caller: "0x000000000022d473030f116ddee9f6b43ac78ba3"},
			},
		},
		{
			name:      "a byte over the bound",
			signature: overBound,
			want:      DepositorSignatureResult{Valid: false, Path: PathNone, Reason: ReasonMalformed, Detail: "the signature is longer than 65536 characters"},
			calls:     []checkerCall{},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			input := base.Input
			input.Signature = c.signature
			fake := &fakeChecker{chain: *base.Chain}
			assert.Equal(t, c.want, VerifyDepositorSignature(context.Background(), input, fake))
			if fake.calls == nil {
				fake.calls = []checkerCall{}
			}
			assert.Equal(t, c.calls, fake.calls, "the checker calls, in order")
		})
	}
}

// RecoverSigner is untouched: the spellings Permit2 accepts and it refuses stay refused, and the
// v 0 spelling Permit2 refuses stays accepted.
func TestRecoverSignerKeepsItsOwnSpelling(t *testing.T) {
	v := readDepositorSignatureVectors(t)
	byName := map[string]DepositorSignature{}
	for _, c := range v.Vectors {
		byName[c.Name] = c.Input
	}
	recoverSigner := func(name string) error {
		in := byName[name]
		_, err := evmAdapter{}.RecoverSigner(SignedMessageInput{Message: in.Digest, Signature: in.Signature}, SourceRef{Network: in.Network, Account: in.Account})
		return err
	}
	require.NoError(t, recoverSigner("eoa-65-byte-v27-recovers"))
	require.NoError(t, recoverSigner("eoa-v0-refused"), "RecoverSigner accepts a recovery id of 0")
	require.ErrorIs(t, recoverSigner("eoa-high-s-recovers"), ErrRecoveryFailed, "RecoverSigner refuses high-s")
	require.ErrorIs(t, recoverSigner("eoa-64-byte-compact-recovers"), ErrRecoveryFailed, "RecoverSigner refuses the 64-byte form")
}
