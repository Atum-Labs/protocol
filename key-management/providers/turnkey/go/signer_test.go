package turnkey

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/rlp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Fixed activity timestamp used across tests. Any positive int64 works —
// the production caller supplies a retry-stable value persisted on the
// rebalance row; tests just need a non-zero placeholder.
const testTimestampMs int64 = 1_700_000_000_000

// testRecipient is the allowlisted custody address used across tests
// (a valid hex address, unlike the placeholder strings used elsewhere).
const testRecipient = "0x000000000000000000000000000000000000bEEF"

func generateP256Hex(t *testing.T) (pubHex, privHex string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	privHex = hex.EncodeToString(priv.D.Bytes())
	pubHex = hex.EncodeToString(elliptic.MarshalCompressed(elliptic.P256(), priv.PublicKey.X, priv.PublicKey.Y))
	return pubHex, privHex
}

// unsignedEIP1559Fields mirrors the RLP layout produced by
// encodeUnsignedEIP1559 — used by the fake Turnkey server to reconstruct
// the request and produce a real signed tx that matches it.
type unsignedEIP1559Fields struct {
	ChainID    *big.Int
	Nonce      uint64
	Tip        *big.Int
	Fee        *big.Int
	Gas        uint64
	To         []byte
	Value      *big.Int
	Data       []byte
	AccessList []interface{}
}

// signUnsignedForTest decodes Turnkey's `unsignedTransaction` payload,
// rebuilds a DynamicFeeTx, signs it with the supplied secp256k1 key, and
// returns the signed-tx hex. Allows the fake server to produce a
// verifiable signed tx that matches whatever the client requested.
func signUnsignedForTest(t *testing.T, unsignedHex string, key *ecdsa.PrivateKey) string {
	t.Helper()
	raw, err := hex.DecodeString(unsignedHex)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(raw), 1)
	require.Equal(t, byte(0x02), raw[0])
	var f unsignedEIP1559Fields
	require.NoError(t, rlp.DecodeBytes(raw[1:], &f))
	var to *common.Address
	if len(f.To) > 0 {
		a := common.BytesToAddress(f.To)
		to = &a
	}
	tx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   f.ChainID,
		Nonce:     f.Nonce,
		GasTipCap: f.Tip,
		GasFeeCap: f.Fee,
		Gas:       f.Gas,
		To:        to,
		Value:     f.Value,
		Data:      f.Data,
	})
	signedTx, err := types.SignTx(tx, types.NewLondonSigner(f.ChainID), key)
	require.NoError(t, err)
	signedBytes, err := signedTx.MarshalBinary()
	require.NoError(t, err)
	return hex.EncodeToString(signedBytes)
}

type fakeTurnkey struct {
	t  *testing.T
	ts *httptest.Server

	signerKey         *ecdsa.PrivateKey
	signerAddr        common.Address
	overrideSignedHex *string

	submitStatus    int
	submitBody      string
	getStatus       int
	pendingThenDone int32
	pollsServed     atomic.Int32
	submitCalls     atomic.Int32
	lastStampHeader atomic.Value
	lastRequestBody atomic.Value
}

func newFakeTurnkey(t *testing.T) *fakeTurnkey {
	t.Helper()
	key, err := crypto.GenerateKey()
	require.NoError(t, err)
	f := &fakeTurnkey{
		t:            t,
		signerKey:    key,
		signerAddr:   crypto.PubkeyToAddress(key.PublicKey),
		submitStatus: 200,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/public/v1/submit/sign_transaction", func(w http.ResponseWriter, r *http.Request) {
		f.submitCalls.Add(1)
		f.lastStampHeader.Store(r.Header.Get("X-Stamp"))
		body, _ := io.ReadAll(r.Body)
		f.lastRequestBody.Store(string(body))
		if f.submitStatus/100 != 2 {
			w.WriteHeader(f.submitStatus)
			_, _ = io.WriteString(w, f.submitBody)
			return
		}
		status := "ACTIVITY_STATUS_COMPLETED"
		if f.pendingThenDone > 0 {
			status = "ACTIVITY_STATUS_PENDING"
		}
		_ = json.NewEncoder(w).Encode(activityEnvelope{Activity: activity{
			ID: "act-1", Status: status,
			Result: activityResult{SignTransactionResult: signTransactionResult{SignedTransaction: f.responseSignedHex(body)}},
		}})
	})
	mux.HandleFunc("/public/v1/query/get_activity", func(w http.ResponseWriter, r *http.Request) {
		f.pollsServed.Add(1)
		httpStatus := f.getStatus
		if httpStatus == 0 {
			httpStatus = 200
		}
		w.WriteHeader(httpStatus)
		if httpStatus/100 != 2 {
			return
		}
		actStatus := "ACTIVITY_STATUS_PENDING"
		if f.pendingThenDone > 0 && f.pollsServed.Load() >= f.pendingThenDone {
			actStatus = "ACTIVITY_STATUS_COMPLETED"
		}
		raw, _ := f.lastRequestBody.Load().(string)
		_ = json.NewEncoder(w).Encode(activityEnvelope{Activity: activity{
			ID: "act-1", Status: actStatus,
			Result: activityResult{SignTransactionResult: signTransactionResult{SignedTransaction: f.responseSignedHex([]byte(raw))}},
		}})
	})
	f.ts = httptest.NewTLSServer(mux)
	t.Cleanup(f.ts.Close)
	return f
}

// responseSignedHex returns the signedTransaction hex the fake server
// should put in the activity result. Default is to RLP-decode the
// request's unsignedTransaction and sign it with the fake signer key so
// verification passes. Tests can override via overrideSignedHex to
// simulate a substituted response.
func (f *fakeTurnkey) responseSignedHex(requestBody []byte) string {
	if f.overrideSignedHex != nil {
		return *f.overrideSignedHex
	}
	var req signTxRequest
	if err := json.Unmarshal(requestBody, &req); err != nil {
		return ""
	}
	if req.Parameters.UnsignedTransaction == "" {
		return ""
	}
	return signUnsignedForTest(f.t, req.Parameters.UnsignedTransaction, f.signerKey)
}

func newTestSigner(t *testing.T, f *fakeTurnkey) *Signer {
	t.Helper()
	pub, priv := generateP256Hex(t)
	hc := f.ts.Client()
	hc.Timeout = 5 * time.Second
	s, err := New(Config{
		BaseURL:          f.ts.URL,
		OrganizationID:   "org-1",
		APIPublicKey:     pub,
		APIPrivateKey:    priv,
		SignWith:         f.signerAddr.Hex(),
		ChainID:          big.NewInt(8453),
		RUSDTokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
		AllowedRecipient: testRecipient,
		HTTPClient:       hc,
		PollInterval:     5 * time.Millisecond,
		PollTimeout:      2 * time.Second,
	})
	require.NoError(t, err)
	return s
}

func gasParams() GasParams {
	return GasParams{
		GasLimit:             100_000,
		MaxFeePerGas:         big.NewInt(2_000_000_000),
		MaxPriorityFeePerGas: big.NewInt(100_000_000),
	}
}

func TestNew_RequiresFields(t *testing.T) {
	pub, priv := generateP256Hex(t)
	base := Config{
		BaseURL: "https://api.turnkey.com", OrganizationID: "o", APIPublicKey: pub, APIPrivateKey: priv,
		SignWith: testRecipient, ChainID: big.NewInt(1), RUSDTokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
		AllowedRecipient: testRecipient,
	}
	cases := []struct {
		name string
		mut  func(*Config)
	}{
		{"BaseURL", func(c *Config) { c.BaseURL = "" }},
		{"OrgID", func(c *Config) { c.OrganizationID = "" }},
		{"PubKey", func(c *Config) { c.APIPublicKey = "" }},
		{"PrivKey", func(c *Config) { c.APIPrivateKey = "" }},
		{"SignWith empty", func(c *Config) { c.SignWith = "" }},
		{"SignWith malformed", func(c *Config) { c.SignWith = "not-an-address" }},
		{"ChainID nil", func(c *Config) { c.ChainID = nil }},
		{"ChainID zero", func(c *Config) { c.ChainID = big.NewInt(0) }},
		{"RUSDToken empty", func(c *Config) { c.RUSDTokenAddress = "" }},
		{"RUSDToken malformed", func(c *Config) { c.RUSDTokenAddress = "not-an-address" }},
		{"AllowedRecipient empty", func(c *Config) { c.AllowedRecipient = "" }},
		{"AllowedRecipient malformed", func(c *Config) { c.AllowedRecipient = "not-an-address" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := base
			tc.mut(&cfg)
			_, err := New(cfg)
			require.Error(t, err)
		})
	}
}

func TestNew_RejectsNonHTTPSBaseURL(t *testing.T) {
	pub, priv := generateP256Hex(t)
	_, err := New(Config{
		BaseURL: "http://api.turnkey.com", OrganizationID: "o", APIPublicKey: pub, APIPrivateKey: priv,
		SignWith: "0xS", ChainID: big.NewInt(1), RUSDTokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
	})
	require.Error(t, err)
}

func TestNew_RejectsMismatchedAPIKeyPair(t *testing.T) {
	pubA, _ := generateP256Hex(t)
	_, privB := generateP256Hex(t)
	_, err := New(Config{
		BaseURL: "https://api.turnkey.com", OrganizationID: "o", APIPublicKey: pubA, APIPrivateKey: privB,
		SignWith: "0xS", ChainID: big.NewInt(1), RUSDTokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
	})
	require.Error(t, err)
}

func TestSignRusdTransfer_HappyPath(t *testing.T) {
	f := newFakeTurnkey(t)
	s := newTestSigner(t, f)
	to := common.HexToAddress(testRecipient)
	signed, err := s.SignRusdTransfer(t.Context(), to, big.NewInt(1_000_000), 42, gasParams(), testTimestampMs)
	require.NoError(t, err)
	require.NotEmpty(t, signed)
	require.Equal(t, int32(1), f.submitCalls.Load())

	stamp, _ := f.lastStampHeader.Load().(string)
	require.NotEmpty(t, stamp, "X-Stamp must be set")
	decoded, err := base64.RawURLEncoding.DecodeString(stamp)
	require.NoError(t, err)
	var payload stampPayload
	require.NoError(t, json.Unmarshal(decoded, &payload))
	assert.Equal(t, "SIGNATURE_SCHEME_TK_API_P256", payload.Scheme)
	assert.NotEmpty(t, payload.Signature)
	assert.NotEmpty(t, payload.PublicKey)

	rawBody, _ := f.lastRequestBody.Load().(string)
	var req signTxRequest
	require.NoError(t, json.Unmarshal([]byte(rawBody), &req))
	assert.Equal(t, "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", req.Type)
	assert.Equal(t, "TRANSACTION_TYPE_ETHEREUM", req.Parameters.Type)
	assert.Equal(t, f.signerAddr.Hex(), req.Parameters.SignWith)
	assert.True(t, strings.HasPrefix(req.Parameters.UnsignedTransaction, "02"), "unsigned tx must be EIP-1559 (type 0x02)")
}

func TestSignRusdTransfer_StampSignatureVerifies(t *testing.T) {
	f := newFakeTurnkey(t)
	s := newTestSigner(t, f)
	_, err := s.SignRusdTransfer(t.Context(), common.HexToAddress(testRecipient),
		big.NewInt(1), 0, gasParams(), testTimestampMs)
	require.NoError(t, err)

	stamp, _ := f.lastStampHeader.Load().(string)
	body, _ := f.lastRequestBody.Load().(string)
	decoded, err := base64.RawURLEncoding.DecodeString(stamp)
	require.NoError(t, err)
	var payload stampPayload
	require.NoError(t, json.Unmarshal(decoded, &payload))
	pubBytes, err := hex.DecodeString(payload.PublicKey)
	require.NoError(t, err)
	x, y := elliptic.UnmarshalCompressed(elliptic.P256(), pubBytes)
	require.NotNil(t, x, "public key must decompress")
	pub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}
	sigBytes, err := hex.DecodeString(payload.Signature)
	require.NoError(t, err)
	var sig derSig
	_, err = asn1.Unmarshal(sigBytes, &sig)
	require.NoError(t, err)
	digest := sha256.Sum256([]byte(body))
	assert.True(t, ecdsa.Verify(pub, digest[:], sig.R, sig.S), "stamp signature must verify against the request body")
}

func TestSignRusdTransfer_CalldataIsERC20Transfer(t *testing.T) {
	f := newFakeTurnkey(t)
	s := newTestSigner(t, f)
	to := common.HexToAddress(testRecipient)
	_, err := s.SignRusdTransfer(t.Context(), to, big.NewInt(0xdeadbeef), 0, gasParams(), testTimestampMs)
	require.NoError(t, err)

	rawBody, _ := f.lastRequestBody.Load().(string)
	var req signTxRequest
	require.NoError(t, json.Unmarshal([]byte(rawBody), &req))
	unsignedBytes, err := hex.DecodeString(req.Parameters.UnsignedTransaction)
	require.NoError(t, err)
	require.Equal(t, byte(0x02), unsignedBytes[0])
	// Selector for transfer(address,uint256) is keccak256-derived 0xa9059cbb.
	require.True(t, bytes.Contains(unsignedBytes, []byte{0xa9, 0x05, 0x9c, 0xbb}), "calldata must contain transfer() selector")
	require.True(t, bytes.Contains(unsignedBytes, to.Bytes()), "calldata must reference destination address")
}

func TestSignRusdTransfer_PollsUntilCompleted(t *testing.T) {
	f := newFakeTurnkey(t)
	f.pendingThenDone = 3
	s := newTestSigner(t, f)
	_, err := s.SignRusdTransfer(t.Context(), common.HexToAddress(testRecipient),
		big.NewInt(1), 0, gasParams(), testTimestampMs)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, f.pollsServed.Load(), int32(2), "must poll get_activity at least once before completion")
}

func TestSignRusdTransfer_RejectsBadInputs(t *testing.T) {
	f := newFakeTurnkey(t)
	s := newTestSigner(t, f)
	to := common.HexToAddress("0x1")
	_, err := s.SignRusdTransfer(t.Context(), to, big.NewInt(0), 0, gasParams(), testTimestampMs)
	require.Error(t, err)
	_, err = s.SignRusdTransfer(t.Context(), to, nil, 0, gasParams(), testTimestampMs)
	require.Error(t, err)
	_, err = s.SignRusdTransfer(t.Context(), to, big.NewInt(1), 0, GasParams{GasLimit: 100_000}, testTimestampMs)
	require.Error(t, err)
	_, err = s.SignRusdTransfer(t.Context(), to, big.NewInt(1), 0, GasParams{MaxFeePerGas: big.NewInt(1), MaxPriorityFeePerGas: big.NewInt(1)}, testTimestampMs)
	require.Error(t, err)
	// timestampMs must be positive — Turnkey dedupes on body fingerprint, so
	// the caller is responsible for a retry-stable value; 0 indicates a bug.
	_, err = s.SignRusdTransfer(t.Context(), to, big.NewInt(1), 0, gasParams(), 0)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "timestampMs")
}

// TestSignRusdTransfer_TimestampIsCallerSupplied confirms the request body
// Turnkey sees carries the caller's timestamp verbatim, not time.Now(). A
// retry with the same timestamp produces a byte-identical body and therefore
// a cached Turnkey activity rather than a new one.
func TestSignRusdTransfer_TimestampIsCallerSupplied(t *testing.T) {
	f := newFakeTurnkey(t)
	s := newTestSigner(t, f)
	const fixed int64 = 1_700_000_000_123
	_, err := s.SignRusdTransfer(t.Context(), common.HexToAddress(testRecipient), big.NewInt(1), 0, gasParams(), fixed)
	require.NoError(t, err)

	rawBody, _ := f.lastRequestBody.Load().(string)
	var req signTxRequest
	require.NoError(t, json.Unmarshal([]byte(rawBody), &req))
	assert.Equal(t, "1700000000123", req.TimestampMs, "request must echo the caller-supplied timestampMs verbatim")
}

func TestSignRusdTransfer_5xxIsTransient(t *testing.T) {
	f := newFakeTurnkey(t)
	f.submitStatus = 503
	f.submitBody = `{"error":"turnkey unavailable"}`
	s := newTestSigner(t, f)
	_, err := s.SignRusdTransfer(t.Context(), common.HexToAddress(testRecipient), big.NewInt(1), 0, gasParams(), testTimestampMs)
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrTransient)
}

func TestSignRusdTransfer_4xxPolicyDenialIsTerminal(t *testing.T) {
	f := newFakeTurnkey(t)
	f.submitStatus = 403
	f.submitBody = `{"error":"policy denied: destination not in allowlist"}`
	s := newTestSigner(t, f)
	_, err := s.SignRusdTransfer(t.Context(), common.HexToAddress(testRecipient),
		big.NewInt(1), 0, gasParams(), testTimestampMs)
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrTerminal)
}

func TestSignRusdTransfer_PollTimeout(t *testing.T) {
	f := newFakeTurnkey(t)
	f.pendingThenDone = 10_000 // never completes within test timeout
	s := newTestSigner(t, f)
	s.pollTimeout = 30 * time.Millisecond
	s.pollInterval = 5 * time.Millisecond
	_, err := s.SignRusdTransfer(t.Context(), common.HexToAddress(testRecipient), big.NewInt(1), 0, gasParams(), testTimestampMs)
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrTransient, "poll timeout is retryable")
}

func TestSignRusdTransfer_FailedActivityIsTerminal(t *testing.T) {
	f := newFakeTurnkey(t)
	// Override submit handler to return ACTIVITY_STATUS_FAILED.
	mux := http.NewServeMux()
	mux.HandleFunc("/public/v1/submit/sign_transaction", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(activityEnvelope{Activity: activity{ID: "act-fail", Status: "ACTIVITY_STATUS_FAILED"}})
	})
	f.ts.Close()
	f.ts = httptest.NewTLSServer(mux)
	t.Cleanup(f.ts.Close)
	s := newTestSigner(t, f)
	_, err := s.SignRusdTransfer(t.Context(), common.HexToAddress(testRecipient), big.NewInt(1), 0, gasParams(), testTimestampMs)
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrTerminal)
}

func TestSignRusdTransfer_EmptySignedTxIsTerminal(t *testing.T) {
	f := newFakeTurnkey(t)
	empty := ""
	f.overrideSignedHex = &empty
	s := newTestSigner(t, f)
	_, err := s.SignRusdTransfer(t.Context(), common.HexToAddress(testRecipient), big.NewInt(1), 0, gasParams(), testTimestampMs)
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrTerminal)
}

func TestSignRusdTransfer_RejectsAmountOverflowingUint256(t *testing.T) {
	f := newFakeTurnkey(t)
	s := newTestSigner(t, f)
	huge := new(big.Int).Lsh(big.NewInt(1), 256) // 2^256
	_, err := s.SignRusdTransfer(t.Context(), common.HexToAddress("0x1"), huge, 0, gasParams(), testTimestampMs)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "overflows uint256")
}

// TestSignRusdTransfer_RejectsSubstitutedSignedTx guards the verification
// step: a Turnkey response that contains a signed tx for a DIFFERENT
// destination or amount must be rejected before we broadcast it.
func TestSignRusdTransfer_RejectsSubstitutedSignedTx(t *testing.T) {
	f := newFakeTurnkey(t)
	// Build a substituted tx: same SignWith key, but a different destination
	// (an attacker address) and a different amount.
	chainID := big.NewInt(8453)
	tokenAddr := common.HexToAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
	attackerDest := common.HexToAddress("0xEvilAddress00000000000000000000000000DEAD")
	substituted := types.NewTx(&types.DynamicFeeTx{
		ChainID:   chainID,
		Nonce:     0,
		GasTipCap: big.NewInt(1),
		GasFeeCap: big.NewInt(2),
		Gas:       100_000,
		To:        &tokenAddr,
		Value:     big.NewInt(0),
		Data:      erc20TransferCalldata(attackerDest, big.NewInt(999_999_999)),
	})
	signed, err := types.SignTx(substituted, types.NewLondonSigner(chainID), f.signerKey)
	require.NoError(t, err)
	signedBytes, err := signed.MarshalBinary()
	require.NoError(t, err)
	hexStr := hex.EncodeToString(signedBytes)
	f.overrideSignedHex = &hexStr

	s := newTestSigner(t, f)
	to := common.HexToAddress(testRecipient)
	_, err = s.SignRusdTransfer(t.Context(), to, big.NewInt(1_000_000), 0, gasParams(), testTimestampMs)
	require.Error(t, err, "substituted signed-tx must be rejected before broadcast")
	assert.ErrorIs(t, err, ErrTerminal)
	assert.Contains(t, err.Error(), "calldata mismatch")
}

func TestSignRusdTransfer_RejectsNonAllowlistedRecipient(t *testing.T) {
	f := newFakeTurnkey(t)
	s := newTestSigner(t, f)
	other := common.HexToAddress("0x00000000000000000000000000000000000000Ab")
	_, err := s.SignRusdTransfer(t.Context(), other, big.NewInt(1_000_000), 0, gasParams(), testTimestampMs)
	require.Error(t, err, "a recipient other than the allowlisted custody address must be rejected")
	assert.Contains(t, err.Error(), "not the allowlisted custody address")
	assert.Equal(t, int32(0), f.submitCalls.Load(), "no signing request may be sent for a disallowed recipient")
}

// TestSignRusdTransfer_RejectsSubstitutedGas guards the gas-field
// verification: a response that keeps the transfer identical but inflates
// the gas fee (which would drain the settler's native balance) is rejected.
func TestSignRusdTransfer_RejectsSubstitutedGas(t *testing.T) {
	f := newFakeTurnkey(t)
	chainID := big.NewInt(8453)
	tokenAddr := common.HexToAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
	recip := common.HexToAddress(testRecipient)
	// Same calldata/to/nonce/limit as the request, but an inflated fee cap.
	substituted := types.NewTx(&types.DynamicFeeTx{
		ChainID:   chainID,
		Nonce:     0,
		GasTipCap: big.NewInt(100_000_000),
		GasFeeCap: big.NewInt(999_000_000_000),
		Gas:       100_000,
		To:        &tokenAddr,
		Value:     big.NewInt(0),
		Data:      erc20TransferCalldata(recip, big.NewInt(1_000_000)),
	})
	signed, err := types.SignTx(substituted, types.NewLondonSigner(chainID), f.signerKey)
	require.NoError(t, err)
	signedBytes, err := signed.MarshalBinary()
	require.NoError(t, err)
	hexStr := hex.EncodeToString(signedBytes)
	f.overrideSignedHex = &hexStr

	s := newTestSigner(t, f)
	_, err = s.SignRusdTransfer(t.Context(), recip, big.NewInt(1_000_000), 0, gasParams(), testTimestampMs)
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrTerminal)
	assert.Contains(t, err.Error(), "maxFeePerGas mismatch")
}

// TestSignRusdTransfer_ContextCancelDuringPoll exercises the awaitCompletion
// cancellation path: a cancelled context returns promptly while polling,
// and the poll timer is stopped on exit.
func TestSignRusdTransfer_ContextCancelDuringPoll(t *testing.T) {
	f := newFakeTurnkey(t)
	f.pendingThenDone = 1_000_000 // never completes
	s := newTestSigner(t, f)
	ctx, cancel := context.WithCancel(t.Context())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	_, err := s.SignRusdTransfer(ctx, common.HexToAddress(testRecipient), big.NewInt(1), 0, gasParams(), testTimestampMs)
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
}
