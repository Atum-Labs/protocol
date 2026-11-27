package senderauth

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/mr-tron/base58"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type commitmentWant struct {
	Outcome                    CommitmentOutcome `json:"outcome"`
	DetailContains             string            `json:"detailContains"`
	SignedDestination          *string           `json:"signedDestination"`
	ExpectedDestination        *string           `json:"expectedDestination"`
	SignedDepositRequestHash   *string           `json:"signedDepositRequestHash"`
	ExpectedDepositRequestHash *string           `json:"expectedDepositRequestHash"`
}

type commitmentVectors struct {
	Requests []struct {
		Name         string           `json:"name"`
		Request      string           `json:"request"`
		Solana       *SolanaDomain    `json:"solana"`
		TronChainIDs map[string]int64 `json:"tronChainIds"`
		Want         commitmentWant   `json:"want"`
		Result       CommitmentResult `json:"result"`
	} `json:"requests"`
	Compare []struct {
		Name                     string                `json:"name"`
		SignedDestination        string                `json:"signedDestination"`
		SignedDepositRequestHash string                `json:"signedDepositRequestHash"`
		Expected                 CommitmentExpectation `json:"expected"`
		Want                     commitmentWant        `json:"want"`
		Result                   CommitmentResult      `json:"result"`
	} `json:"compare"`
}

func conformancePath(name string) string {
	return filepath.Join("..", "..", "..", "..", "conformance", name)
}

func assertCommitment(t *testing.T, got CommitmentResult, err error, want commitmentWant) {
	t.Helper()
	assert.Equal(t, want.Outcome, got.Outcome, "detail: %s", got.Detail)
	if got.Verified() {
		assert.NoError(t, err)
	} else {
		var ce *CommitmentError
		require.True(t, errors.As(err, &ce), "a refusal returns a *CommitmentError")
		assert.Equal(t, got, ce.Result)
	}
	if want.DetailContains != "" {
		assert.Contains(t, got.Detail, want.DetailContains)
	}
	for _, f := range []struct {
		want *string
		got  string
		name string
	}{
		{want.SignedDestination, got.SignedDestination, "signedDestination"},
		{want.ExpectedDestination, got.ExpectedDestination, "expectedDestination"},
		{want.SignedDepositRequestHash, got.SignedDepositRequestHash, "signedDepositRequestHash"},
		{want.ExpectedDepositRequestHash, got.ExpectedDepositRequestHash, "expectedDepositRequestHash"},
	} {
		if f.want != nil {
			assert.Equal(t, *f.want, f.got, f.name)
		}
	}
}

// The shared vectors the TypeScript suite generates and asserts.
func TestCommitmentVectors(t *testing.T) {
	raw, err := os.ReadFile(conformancePath("commitment-vectors.json"))
	require.NoError(t, err)
	var v commitmentVectors
	require.NoError(t, json.Unmarshal(raw, &v))
	require.NotEmpty(t, v.Requests)
	require.NotEmpty(t, v.Compare)

	for _, c := range v.Requests {
		t.Run(c.Name, func(t *testing.T) {
			got, err := VerifyRequestCommitment([]byte(c.Request), c.Solana, WithTronChainIDs(c.TronChainIDs))
			assertCommitment(t, got, err, c.Want)
			assert.Equal(t, c.Result, got, "Go and TypeScript must return the same result")
		})
	}
	for _, c := range v.Compare {
		t.Run(c.Name, func(t *testing.T) {
			got, err := CompareCommitment(c.SignedDestination, c.SignedDepositRequestHash, c.Expected)
			assertCommitment(t, got, err, c.Want)
			assert.Equal(t, c.Result, got, "Go and TypeScript must return the same result")
		})
	}
}

type namedRequest struct {
	Name    string        `json:"name"`
	Request string        `json:"request"`
	Solana  *SolanaDomain `json:"solana,omitempty"`
}

// goBuiltRequests are honest payments built and signed by this Go SDK with fixed inputs, so the
// TypeScript suite can prove it accepts Go-shaped prehashes (EIP712Domain in types, empty version
// and salt in the domain).
func goBuiltRequests(t *testing.T) []namedRequest {
	t.Helper()
	build := func(name string, adapter ChainAdapter, keyHex string, params BuildParams, destinationAsset, destinationAccount string) namedRequest {
		params.DestinationAsset = destinationAsset
		params.DestinationAccount = destinationAccount
		res, err := adapter.BuildAuthMessage(params)
		require.NoError(t, err)
		prehash := res.MessagePrehash
		sig, err := adapter.Sign(SignedMessageInput{Message: res.MessageHash, MessagePrehash: &prehash}, keyHex)
		require.NoError(t, err)
		key, err := crypto.HexToECDSA(keyHex)
		require.NoError(t, err)
		request, err := json.Marshal(map[string]any{
			"request_id":  params.RequestID,
			"source":      map[string]any{"asset_identifier": params.SourceAsset, "account": crypto.PubkeyToAddress(key.PublicKey).Hex()},
			"destination": []any{map[string]any{"asset_identifier": destinationAsset, "account": destinationAccount}},
			"sender_auth": map[string]any{
				"message_scheme":  string(res.MessageScheme),
				"signed_messages": []any{map[string]any{"message": res.MessageHash, "signature": sig, "message_prehash": prehash}},
			},
		})
		require.NoError(t, err)
		return namedRequest{Name: name, Request: string(request)}
	}
	solanaRequest := func() namedRequest {
		seed := strings.Repeat("05", 32)
		seedBytes, _ := hex.DecodeString(seed)
		payer := base58.Encode(ed25519.NewKeyFromSeed(seedBytes).Public().(ed25519.PublicKey))
		keys := func(fill byte) string { return base58.Encode(bytes.Repeat([]byte{fill}, 32)) }
		version := 5
		nonce, err := DeterministicSolanaNonce("req_commit_sol_go", payer)
		require.NoError(t, err)
		asset := "solana:mainnet/spl:" + keys(9)
		res, err := solanaAdapter{}.BuildAuthMessage(BuildParams{
			SourceAsset: asset, Depositor: payer, MaxSourceAmount: "1000000", RequestID: "req_commit_sol_go",
			SourceDefaults: ChainDefaults{
				EscrowContract: keys(1), QuoteSelector: keys(2), FulfillmentVerifierAccount: keys(3),
				SvmSignatureClusterID: "devnet", SvmSignatureDomainVersion: &version,
			},
			DestinationAsset:   "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo",
			DestinationAccount: "7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4",
			Nonce:              new(big.Int).SetUint64(nonce),
			SolanaClock:        func(string) (uint64, error) { return 1700000000, nil },
		})
		require.NoError(t, err)
		prehash := res.MessagePrehash
		sig, err := solanaAdapter{}.Sign(SignedMessageInput{Message: res.MessageHash, MessagePrehash: &prehash}, seed)
		require.NoError(t, err)
		request, err := json.Marshal(map[string]any{
			"request_id":  "req_commit_sol_go",
			"source":      map[string]any{"asset_identifier": asset, "account": payer},
			"destination": []any{map[string]any{"asset_identifier": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo", "account": "7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4"}},
			"sender_auth": map[string]any{
				"message_scheme":  string(res.MessageScheme),
				"signed_messages": []any{map[string]any{"message": res.MessageHash, "signature": sig, "message_prehash": prehash, "payload": map[string]any{"delegate_signer": payer}}},
			},
		})
		require.NoError(t, err)
		return namedRequest{Name: "go-built-solana", Request: string(request), Solana: &SolanaDomain{EscrowProgramID: keys(1), ClusterID: "devnet", DomainVersion: version}}
	}
	evmDefaults, evmToken := evmTestDefaults()
	tronDefaults, tronToken := tronTestDefaults()
	return []namedRequest{
		build("go-built-evm", evmAdapter{}, strings.Repeat("11", 32), BuildParams{
			SourceAsset: "eip155:1/erc20:" + evmToken, MaxSourceAmount: "1000000", SourceDefaults: evmDefaults,
			RequestID: "req_commit_evm_go", Nonce: big.NewInt(123), Deadline: big.NewInt(1924991999),
		}, "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0xC0FFEE254729296a45a3885639AC7E10F9d54979"),
		build("go-built-tron", tronAdapter{}, strings.Repeat("22", 32), BuildParams{
			SourceAsset: "tron:mainnet/trc20:" + tronToken, MaxSourceAmount: "10000000", SourceDefaults: tronDefaults,
			RequestID: "req_commit_tron_go", Nonce: big.NewInt(456), Deadline: big.NewInt(1924991999),
		}, "tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB"),
		solanaRequest(),
	}
}

// Go-built honest payments verify here, and the committed fixture the TypeScript suite reads is
// exactly what this SDK builds. Regenerate: REGEN_COMMITMENT_GO_FIXTURE=1 go test ./senderauth.
func TestCommitmentGoBuiltPayments(t *testing.T) {
	requests := goBuiltRequests(t)
	for _, c := range requests {
		got, err := VerifyRequestCommitment([]byte(c.Request), c.Solana)
		require.NoError(t, err, c.Name)
		assert.Equal(t, OutcomeVerified, got.Outcome, c.Name)
	}
	fixture, err := json.MarshalIndent(map[string]any{
		"_comment": "Honest payments built by the Go sender-auth SDK with fixed inputs. Every verifier must admit them. " +
			"Regenerate: REGEN_COMMITMENT_GO_FIXTURE=1 go test ./senderauth (in bindings/go/sender-auth).",
		"requests": requests,
	}, "", "  ")
	require.NoError(t, err)
	fixture = append(fixture, '\n')
	path := conformancePath("commitment-go-built.json")
	if os.Getenv("REGEN_COMMITMENT_GO_FIXTURE") == "1" {
		require.NoError(t, os.WriteFile(path, fixture, 0o644))
	}
	committed, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, string(fixture), string(committed), "commitment-go-built.json is stale; regenerate it")
}

func TestVerifyCommitment_RefusesASolanaSourceWithoutADomain(t *testing.T) {
	got, err := VerifyCommitment(SignedDeposit{
		SourceAssetIdentifier: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
		MessageScheme:         "SOLANA",
		SignedMessages:        []SignedMessageInput{{}},
	}, CommitmentExpectation{}, nil)
	require.Error(t, err)
	assert.Equal(t, OutcomeVerifierMisconfigured, got.Outcome)
}

// The source chain, and so the chain ids, is read after the signed messages. Mirrors the TS test.
func TestVerifyCommitment_ReportsNoSignedMessagesBeforeAnUnusableTronChainID(t *testing.T) {
	_, err := VerifyCommitment(SignedDeposit{
		SourceAssetIdentifier: "tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
		SourceAccount:         "TBvJUBXorwBPzqvV38vjDgegj5Eh6g2Tsq",
		MessageScheme:         "EVM_PERMIT2",
	}, CommitmentExpectation{}, nil, WithTronChainIDs(map[string]int64{"mainnet": 1}))
	requireCommitmentOutcome(t, err, OutcomeCommitmentAbsent)
}

// A later WithTronChainIDs replaces an earlier one, and a nil option is skipped.
func TestWithTronChainIDs_LaterReplacesEarlier(t *testing.T) {
	raw, err := os.ReadFile(conformancePath("commitment-vectors.json"))
	require.NoError(t, err)
	var v commitmentVectors
	require.NoError(t, json.Unmarshal(raw, &v))
	var localnet []byte
	for _, c := range v.Requests {
		if c.Name == "tron-localnet-chain-id-supplied" {
			localnet = []byte(c.Request)
		}
	}
	require.NotEmpty(t, localnet)

	usable := WithTronChainIDs(map[string]int64{"localnet": 3360022319})
	unusable := WithTronChainIDs(map[string]int64{"localnet": 0})
	_, err = VerifyRequestCommitment(localnet, nil, unusable, usable)
	require.NoError(t, err)
	_, err = VerifyRequestCommitment(localnet, nil, usable, unusable)
	requireCommitmentOutcome(t, err, OutcomeVerifierMisconfigured)
	_, err = VerifyRequestCommitment(localnet, nil, usable, nil)
	require.NoError(t, err)
	_, err = VerifyRequestCommitment(localnet, nil, usable, WithTronChainIDs(nil))
	requireCommitmentOutcome(t, err, OutcomeSchemeMismatch)
}

func TestCommitmentResult_LogFieldsKeys(t *testing.T) {
	got, _ := CompareCommitment("", "", CommitmentExpectation{})
	keys := make([]string, 0)
	for k := range got.LogFields() {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	assert.Equal(t, []string{
		"detail", "request_deposit_request_hash", "request_destination", "scheme", "sender_auth_result",
		"signed_deposit_request_hash", "signed_destination", "source_namespace",
	}, keys)
}

func TestCommitmentError_Message(t *testing.T) {
	_, err := CompareCommitment("", "", CommitmentExpectation{})
	require.EqualError(t, err, "sender_auth: commitment_absent: "+detailNoDestination)
}

// The request as bytes: invalid UTF-8 is refused. Mirrors the TypeScript "verifyRequestCommitment on
// raw bytes" tests.
func TestVerifyRequestCommitmentBytes(t *testing.T) {
	raw, err := os.ReadFile(conformancePath("commitment-vectors.json"))
	require.NoError(t, err)
	var v commitmentVectors
	require.NoError(t, json.Unmarshal(raw, &v))
	var honest string
	for _, c := range v.Requests {
		if c.Name == "evm-honest" {
			honest = c.Request
		}
	}
	require.NotEmpty(t, honest)

	r, err := VerifyRequestCommitment([]byte(honest), nil)
	require.NoError(t, err)
	require.True(t, r.Verified())

	invalid := append(append([]byte(`{"note":"`), 0xff), []byte(`",`+honest[1:])...)
	r, err = VerifyRequestCommitment(invalid, nil)
	requireCommitmentOutcome(t, err, OutcomeRequestMalformed)
	require.Equal(t, "the payment request is not a single valid JSON document", r.Detail)
}
