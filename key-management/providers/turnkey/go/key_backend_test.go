package turnkey

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	evmKeyID    = "EIP155_42161"
	tronKeyID   = "TRON_MAINNET"
	solanaKeyID = "SOLANA_MAINNET"
	tronSignAs  = "TEdvoHEatmDKvTh3o9vBRB9Vdtbhn4QFhy"
)

// fakeRawPayloadTurnkey answers sign_raw_payload the way Turnkey does: EIP712 payloads are parsed
// and signed as typed data with the secp256k1 key, HEXADECIMAL payloads are signed as raw bytes
// with the ed25519 key. Every request body is recorded.
type fakeRawPayloadTurnkey struct {
	t  *testing.T
	ts *httptest.Server

	secpKey *ecdsa.PrivateKey
	edKey   ed25519.PrivateKey

	// respond overrides the signature parts when set.
	respond func(p signRawPayloadParameters) signRawPayloadResult

	mu       sync.Mutex
	requests []signRawPayloadRequest
}

func newFakeRawPayloadTurnkey(t *testing.T) *fakeRawPayloadTurnkey {
	t.Helper()
	secp, err := crypto.GenerateKey()
	require.NoError(t, err)
	_, ed, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	f := &fakeRawPayloadTurnkey{t: t, secpKey: secp, edKey: ed}
	mux := http.NewServeMux()
	mux.HandleFunc("/public/v1/submit/sign_raw_payload", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req signRawPayloadRequest
		require.NoError(t, json.Unmarshal(body, &req))
		f.mu.Lock()
		f.requests = append(f.requests, req)
		f.mu.Unlock()
		res := f.sign(req.Parameters)
		if f.respond != nil {
			res = f.respond(req.Parameters)
		}
		_ = json.NewEncoder(w).Encode(activityEnvelope{Activity: activity{
			ID: "act-raw", Status: "ACTIVITY_STATUS_COMPLETED",
			Result: activityResult{SignRawPayloadResult: res},
		}})
	})
	f.ts = httptest.NewTLSServer(mux)
	t.Cleanup(f.ts.Close)
	return f
}

func (f *fakeRawPayloadTurnkey) sign(p signRawPayloadParameters) signRawPayloadResult {
	switch p.Encoding {
	case "PAYLOAD_ENCODING_EIP712":
		var td apitypes.TypedData
		require.NoError(f.t, json.Unmarshal([]byte(p.Payload), &td))
		digest, _, err := apitypes.TypedDataAndHash(td)
		require.NoError(f.t, err)
		sig, err := crypto.Sign(digest, f.secpKey)
		require.NoError(f.t, err)
		return signRawPayloadResult{
			R: hex.EncodeToString(sig[:32]), S: hex.EncodeToString(sig[32:64]),
			V: hex.EncodeToString(sig[64:]),
		}
	case "PAYLOAD_ENCODING_HEXADECIMAL":
		msg, err := hex.DecodeString(p.Payload)
		require.NoError(f.t, err)
		sig := ed25519.Sign(f.edKey, msg)
		return signRawPayloadResult{R: hex.EncodeToString(sig[:32]), S: hex.EncodeToString(sig[32:])}
	}
	f.t.Fatalf("unexpected encoding %s", p.Encoding)
	return signRawPayloadResult{}
}

func (f *fakeRawPayloadTurnkey) recorded() []signRawPayloadRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]signRawPayloadRequest(nil), f.requests...)
}

func (f *fakeRawPayloadTurnkey) evmAddress() common.Address {
	return crypto.PubkeyToAddress(f.secpKey.PublicKey)
}

func (f *fakeRawPayloadTurnkey) keys() map[string]KeyConfig {
	secpPub := hex.EncodeToString(crypto.CompressPubkey(&f.secpKey.PublicKey))
	return map[string]KeyConfig{
		evmKeyID:    {SignWith: f.evmAddress().Hex(), PublicKey: secpPub},
		tronKeyID:   {SignWith: tronSignAs, PublicKey: secpPub},
		solanaKeyID: {SignWith: "solana-account", PublicKey: hex.EncodeToString(f.edKey.Public().(ed25519.PublicKey))},
	}
}

func newTestKeyBackend(t *testing.T, f *fakeRawPayloadTurnkey) *KeyBackend {
	t.Helper()
	pub, priv := generateP256Hex(t)
	hc := f.ts.Client()
	hc.Timeout = 5 * time.Second
	b, err := NewKeyBackend(KeyBackendConfig{
		BaseURL:        f.ts.URL,
		OrganizationID: "org-verifier",
		APIPublicKey:   pub,
		APIPrivateKey:  priv,
		Keys:           f.keys(),
		HTTPClient:     hc,
		PollInterval:   5 * time.Millisecond,
		PollTimeout:    2 * time.Second,
	})
	require.NoError(t, err)
	return b
}

// releaseWitness mirrors the escrow's V3 ReleaseWitness, with checksummed addresses and a hex
// chain id, the form go-ethereum's encoders produce.
func releaseWitness(chainID int64) apitypes.TypedData {
	return apitypes.TypedData{
		Types: apitypes.Types{
			"EIP712Domain": {
				{Name: "name", Type: "string"},
				{Name: "version", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"ReleaseWitness": {
				{Name: "depositId", Type: "bytes32"},
				{Name: "quoteHash", Type: "bytes32"},
				{Name: "depositRequestHash", Type: "bytes32"},
				{Name: "destinationHash", Type: "bytes32"},
				{Name: "depositor", Type: "address"},
				{Name: "token", Type: "address"},
				{Name: "amount", Type: "uint256"},
				{Name: "feeAmount", Type: "uint256"},
				{Name: "reserver", Type: "address"},
				{Name: "releaser", Type: "address"},
				{Name: "settler", Type: "address"},
			},
		},
		PrimaryType: "ReleaseWitness",
		Domain: apitypes.TypedDataDomain{
			Name:              "Escrow",
			Version:           "3",
			ChainId:           math.NewHexOrDecimal256(chainID),
			VerifyingContract: "0xAbCdEf0000000000000000000000000000000001",
		},
		Message: apitypes.TypedDataMessage{
			"depositId":          "0x" + strings.Repeat("11", 32),
			"quoteHash":          "0x" + strings.Repeat("22", 32),
			"depositRequestHash": "0x" + strings.Repeat("33", 32),
			"destinationHash":    "0x" + strings.Repeat("44", 32),
			"depositor":          "0xC0FfEe0000000000000000000000000000000003",
			"token":              "0xAaAa000000000000000000000000000000000004",
			"amount":             "1000000",
			"feeAmount":          "200",
			"reserver":           "0xBbBb000000000000000000000000000000000005",
			"releaser":           "0xFeDcBa0000000000000000000000000000000002",
			"settler":            "0xCcCc000000000000000000000000000000000006",
		},
	}
}

func TestKeyBackend_TypedDataIsSentAsEIP712Activity(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	b := newTestKeyBackend(t, f)
	td := releaseWitness(42161)

	sig, err := b.SignTypedData(context.Background(), td, evmKeyID, "eip155:42161")
	require.NoError(t, err)

	reqs := f.recorded()
	require.Len(t, reqs, 1)
	p := reqs[0].Parameters
	assert.Equal(t, "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2", reqs[0].Type)
	assert.Equal(t, "org-verifier", reqs[0].OrganizationID)
	assert.Equal(t, "PAYLOAD_ENCODING_EIP712", p.Encoding)
	assert.Equal(t, "HASH_FUNCTION_NOT_APPLICABLE", p.HashFunction)
	assert.Equal(t, f.evmAddress().Hex(), p.SignWith)

	// The policy literals are lowercase and the chain id is compared as an integer, so the payload
	// must carry exactly that form.
	var sent map[string]any
	require.NoError(t, json.Unmarshal([]byte(p.Payload), &sent))
	domain := sent["domain"].(map[string]any)
	message := sent["message"].(map[string]any)
	assert.Equal(t, "ReleaseWitness", sent["primaryType"])
	assert.Equal(t, float64(42161), domain["chainId"])
	assert.Equal(t, "0xabcdef0000000000000000000000000000000001", domain["verifyingContract"])
	assert.Equal(t, "0xfedcba0000000000000000000000000000000002", message["releaser"])
	assert.Equal(t, "0xcccc000000000000000000000000000000000006", message["settler"])
	assert.Equal(t, "1000000", message["amount"])

	// Round trip: the signature recovers to the address GetPublicKey reports.
	digest, _, err := apitypes.TypedDataAndHash(td)
	require.NoError(t, err)
	require.Len(t, sig, 65)
	assert.Contains(t, []byte{27, 28}, sig[64])
	recoverable := append([]byte(nil), sig...)
	recoverable[64] -= 27
	recovered, err := crypto.SigToPub(digest, recoverable)
	require.NoError(t, err)
	pub, err := b.GetPublicKey(context.Background(), evmKeyID, "eip155:42161")
	require.NoError(t, err)
	assert.Equal(t, crypto.PubkeyToAddress(*pub.(*ecdsa.PublicKey)), crypto.PubkeyToAddress(*recovered))
}

func TestKeyBackend_TronSignsTypedDataWithItsOwnSignWith(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	b := newTestKeyBackend(t, f)

	_, err := b.SignTypedData(context.Background(), releaseWitness(728126428), tronKeyID, "tron:mainnet")
	require.NoError(t, err)

	reqs := f.recorded()
	require.Len(t, reqs, 1)
	assert.Equal(t, tronSignAs, reqs[0].Parameters.SignWith)
	assert.Equal(t, "PAYLOAD_ENCODING_EIP712", reqs[0].Parameters.Encoding)
}

func TestKeyBackend_Secp256k1DigestIsRefusedWithoutReachingTurnkey(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	b := newTestKeyBackend(t, f)

	for _, tc := range []struct{ keyID, chainID string }{
		{evmKeyID, "eip155:42161"},
		{tronKeyID, "tron:mainnet"},
	} {
		_, err := b.Sign(context.Background(), make([]byte, 32), tc.keyID, tc.chainID)
		assert.ErrorIs(t, err, ErrDigestSigningRefused, tc.chainID)
	}
	assert.Empty(t, f.recorded())
}

func TestKeyBackend_SolanaSignsRawEd25519Payload(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	b := newTestKeyBackend(t, f)
	digest := crypto.Keccak256([]byte("release"))

	sig, err := b.Sign(context.Background(), digest, solanaKeyID, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
	require.NoError(t, err)

	reqs := f.recorded()
	require.Len(t, reqs, 1)
	p := reqs[0].Parameters
	assert.Equal(t, "PAYLOAD_ENCODING_HEXADECIMAL", p.Encoding)
	assert.Equal(t, "HASH_FUNCTION_NOT_APPLICABLE", p.HashFunction)
	assert.Equal(t, hex.EncodeToString(digest), p.Payload)

	pub, err := b.GetPublicKey(context.Background(), solanaKeyID, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
	require.NoError(t, err)
	assert.True(t, ed25519.Verify(pub.(ed25519.PublicKey), digest, sig))
}

func TestKeyBackend_SubstitutedSignatureIsRejected(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	b := newTestKeyBackend(t, f)
	other, err := crypto.GenerateKey()
	require.NoError(t, err)
	_, otherEd, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	f.respond = func(p signRawPayloadParameters) signRawPayloadResult {
		if p.Encoding == "PAYLOAD_ENCODING_HEXADECIMAL" {
			msg, _ := hex.DecodeString(p.Payload)
			sig := ed25519.Sign(otherEd, msg)
			return signRawPayloadResult{R: hex.EncodeToString(sig[:32]), S: hex.EncodeToString(sig[32:])}
		}
		var td apitypes.TypedData
		require.NoError(t, json.Unmarshal([]byte(p.Payload), &td))
		digest, _, _ := apitypes.TypedDataAndHash(td)
		sig, _ := crypto.Sign(digest, other)
		return signRawPayloadResult{R: hex.EncodeToString(sig[:32]), S: hex.EncodeToString(sig[32:64]), V: hex.EncodeToString(sig[64:])}
	}

	_, err = b.SignTypedData(context.Background(), releaseWitness(42161), evmKeyID, "eip155:42161")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "recovers to")

	_, err = b.Sign(context.Background(), make([]byte, 32), solanaKeyID, "solana:x")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "does not verify")
}

func TestKeyBackend_HighSIsNormalized(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	b := newTestKeyBackend(t, f)
	f.respond = func(p signRawPayloadParameters) signRawPayloadResult {
		res := f.sign(p)
		s, _ := new(big.Int).SetString(res.S, 16)
		high := new(big.Int).Sub(secp256k1N, s)
		v := res.V
		if v == "00" {
			v = "01"
		} else {
			v = "00"
		}
		return signRawPayloadResult{R: res.R, S: hex.EncodeToString(high.FillBytes(make([]byte, 32))), V: v}
	}

	sig, err := b.SignTypedData(context.Background(), releaseWitness(42161), evmKeyID, "eip155:42161")
	require.NoError(t, err)
	assert.LessOrEqual(t, new(big.Int).SetBytes(sig[32:64]).Cmp(secp256k1HalfN), 0)
}

func TestKeyBackend_PolicyDenialIsTerminal(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/public/v1/submit/sign_raw_payload", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"message":"policy denied"}`)
	})
	f.ts.Config.Handler = mux
	b := newTestKeyBackend(t, f)

	_, err := b.SignTypedData(context.Background(), releaseWitness(42161), evmKeyID, "eip155:42161")
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrTerminal))
}

func TestKeyBackend_WrongCurveForChainIsRefused(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	b := newTestKeyBackend(t, f)

	_, err := b.SignTypedData(context.Background(), releaseWitness(1), solanaKeyID, "eip155:1")
	assert.ErrorContains(t, err, "wrong curve")
	_, err = b.Sign(context.Background(), make([]byte, 32), evmKeyID, "solana:x")
	assert.ErrorContains(t, err, "wrong curve")
	_, err = b.GetPublicKey(context.Background(), "UNKNOWN", "eip155:1")
	assert.ErrorContains(t, err, "no key configured")
	assert.Empty(t, f.recorded())
}

func TestNewKeyBackend_RejectsBadKeys(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	pub, priv := generateP256Hex(t)
	good := f.keys()[evmKeyID]
	base := KeyBackendConfig{
		BaseURL: f.ts.URL, OrganizationID: "org", APIPublicKey: pub, APIPrivateKey: priv,
	}

	for name, keys := range map[string]map[string]KeyConfig{
		"none":             {},
		"no sign with":     {evmKeyID: {PublicKey: good.PublicKey}},
		"not hex":          {evmKeyID: {SignWith: good.SignWith, PublicKey: "zz"}},
		"bad length":       {evmKeyID: {SignWith: good.SignWith, PublicKey: "abcd"}},
		"address mismatch": {evmKeyID: {SignWith: "0x000000000000000000000000000000000000dEaD", PublicKey: good.PublicKey}},
	} {
		cfg := base
		cfg.Keys = keys
		_, err := NewKeyBackend(cfg)
		assert.Error(t, err, name)
	}
}

func TestCanonicalTypedDataJSON_PreservesDigest(t *testing.T) {
	td := releaseWitness(728126428)
	payload, err := canonicalTypedDataJSON(td)
	require.NoError(t, err)
	var reparsed apitypes.TypedData
	require.NoError(t, json.Unmarshal(payload, &reparsed))

	want, _, err := apitypes.TypedDataAndHash(td)
	require.NoError(t, err)
	got, _, err := apitypes.TypedDataAndHash(reparsed)
	require.NoError(t, err)
	assert.Equal(t, want, got)
}

// orgReplies shapes the fake organization the query endpoints describe. The zero value is a
// non-root agent in org-verifier that holds every key of the fake, with its public key.
type orgReplies struct {
	whoamiStatus  int
	whoamiBody    string
	walletStatus  int
	accountStatus int
	orgBody       string
	// wallets replaces the default single wallet w-1, which holds every key of the fake.
	wallets []fakeWallet
}

// fakeWallet is one listed wallet. created is its createdAt: seconds, an at value, or nil for none.
type fakeWallet struct {
	id       string
	created  any
	accounts []map[string]any
}

// at is a createdAt with nanos, for entries that differ only below the second.
type at struct{ seconds, nanos string }

// createdAt is Turnkey's createdAt for seconds, or for an at value.
func createdAt(created any) map[string]any {
	if a, ok := created.(at); ok {
		return map[string]any{"seconds": a.seconds, "nanos": a.nanos}
	}
	return map[string]any{"seconds": created, "nanos": "0"}
}

// account is one listed wallet account created at created (seconds, or an at value).
func account(address, publicKey, format string, created any) map[string]any {
	return map[string]any{"address": address, "publicKey": publicKey, "addressFormat": format,
		"createdAt": createdAt(created)}
}

var keyFormats = map[string]string{evmKeyID: AddressFormatEthereum, tronKeyID: AddressFormatTron, solanaKeyID: AddressFormatSolana}

func serveOrg(t *testing.T, f *fakeRawPayloadTurnkey, o orgReplies) {
	t.Helper()
	wallets := o.wallets
	if wallets == nil {
		accounts := []map[string]any{}
		for id, k := range f.keys() {
			accounts = append(accounts, account(k.SignWith, k.PublicKey, keyFormats[id], "1700000000"))
		}
		wallets = []fakeWallet{{id: "w-1", created: "1700000000", accounts: accounts}}
	}
	reply := func(w http.ResponseWriter, status int, body any) {
		if status == 0 {
			status = http.StatusOK
		}
		w.WriteHeader(status)
		if s, ok := body.(string); ok {
			_, _ = io.WriteString(w, s)
			return
		}
		_ = json.NewEncoder(w).Encode(body)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/public/v1/query/whoami", func(w http.ResponseWriter, _ *http.Request) {
		body := o.whoamiBody
		if body == "" {
			body = `{"organizationId":"org-verifier","userId":"agent"}`
		}
		reply(w, o.whoamiStatus, body)
	})
	mux.HandleFunc("/public/v1/query/get_organization", func(w http.ResponseWriter, _ *http.Request) {
		if o.orgBody != "" {
			reply(w, 0, o.orgBody)
			return
		}
		reply(w, 0, map[string]any{"organizationData": map[string]any{"rootQuorum": map[string]any{"threshold": 1, "userIds": []string{"root"}}}})
	})
	mux.HandleFunc("/public/v1/query/list_wallets", func(w http.ResponseWriter, _ *http.Request) {
		listed := []map[string]any{}
		for _, fw := range wallets {
			entry := map[string]any{"walletId": fw.id}
			if fw.created != nil {
				entry["createdAt"] = createdAt(fw.created)
			}
			listed = append(listed, entry)
		}
		reply(w, o.walletStatus, map[string]any{"wallets": listed})
	})
	mux.HandleFunc("/public/v1/query/list_wallet_accounts", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			WalletID string `json:"walletId"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
		accounts := []map[string]any{}
		for _, fw := range wallets {
			if fw.id == req.WalletID {
				accounts = fw.accounts
			}
		}
		reply(w, o.accountStatus, map[string]any{"accounts": accounts})
	})
	f.ts.Config.Handler = mux
}

func TestResolveWallet_PicksTheOldestWalletAndAccountPerFormat(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	keys := f.keys()
	evm, tron, sol := keys[evmKeyID], keys[tronKeyID], keys[solanaKeyID]
	other, err := crypto.GenerateKey()
	require.NoError(t, err)
	otherPub := hex.EncodeToString(crypto.CompressPubkey(&other.PublicKey))
	otherAddr := crypto.PubkeyToAddress(other.PublicKey).Hex()
	_, otherEd, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	otherEdPub := hex.EncodeToString(otherEd.Public().(ed25519.PublicKey))

	main := fakeWallet{id: "w-main", created: "1700000000", accounts: []map[string]any{
		// A newer EVM account listed first must not displace the oldest one.
		account(otherAddr, otherPub, AddressFormatEthereum, "1700000500"),
		account(evm.SignWith, evm.PublicKey, AddressFormatEthereum, "1700000001"),
		account(tron.SignWith, tron.PublicKey, AddressFormatTron, 1700000001),
		account(sol.SignWith, sol.PublicKey, AddressFormatSolana, "1700000001"),
		account("bc1-not-signed", "not-a-key", "ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH", "1600000000"),
	}}
	newer := fakeWallet{id: "w-newer", created: "1800000000", accounts: []map[string]any{
		account(otherAddr, otherPub, AddressFormatEthereum, "1800000000"),
		account("other-solana", otherEdPub, AddressFormatSolana, "1800000000"),
	}}
	want := map[string]KeyConfig{
		AddressFormatEthereum: evm, AddressFormatTron: tron, AddressFormatSolana: sol,
	}
	// The same accounts with the oldest EVM account listed first.
	oldestFirst := fakeWallet{id: "w-main", created: "1700000000", accounts: []map[string]any{
		main.accounts[1], main.accounts[0], main.accounts[2], main.accounts[3],
	}}
	// Two EVM accounts created together: the lower address signs, whichever is listed first.
	tieWinner, tieLoser := evm, KeyConfig{SignWith: otherAddr, PublicKey: otherPub}
	if otherAddr < evm.SignWith {
		tieWinner, tieLoser = tieLoser, tieWinner
	}
	tied := func(first, second KeyConfig) []fakeWallet {
		return []fakeWallet{{id: "w-tie", created: "1700000000", accounts: []map[string]any{
			account(first.SignWith, first.PublicKey, AddressFormatEthereum, "1700000001"),
			account(second.SignWith, second.PublicKey, AddressFormatEthereum, "1700000001"),
		}}}
	}
	tieWant := map[string]KeyConfig{AddressFormatEthereum: tieWinner}
	// w-b is older by nanos alone, so the id would pick the other.
	nanoOld := fakeWallet{id: "w-b", created: at{"1700000000", "1"}, accounts: main.accounts}
	nanoNew := fakeWallet{id: "w-a", created: at{"1700000000", "5"}, accounts: newer.accounts}
	for name, tc := range map[string]struct {
		wallets  []fakeWallet
		walletID string
		wantID   string
		want     map[string]KeyConfig
	}{
		"oldest wallet when none is named":    {wallets: []fakeWallet{newer, main}, wantID: "w-main", want: want},
		"named wallet":                        {wallets: []fakeWallet{main, newer}, walletID: "w-newer", wantID: "w-newer", want: map[string]KeyConfig{AddressFormatEthereum: {SignWith: otherAddr, PublicKey: otherPub}, AddressFormatSolana: {SignWith: "other-solana", PublicKey: otherEdPub}}},
		"one wallet without createdAt":        {wallets: []fakeWallet{{id: "w-main", accounts: main.accounts}}, wantID: "w-main", want: want},
		"same createdAt falls to the id":      {wallets: []fakeWallet{{id: "w-b", created: "1700000000", accounts: newer.accounts}, {id: "w-a", created: "1700000000", accounts: main.accounts}}, wantID: "w-a", want: want},
		"oldest wallet listed first":          {wallets: []fakeWallet{main, newer}, wantID: "w-main", want: want},
		"oldest account listed first":         {wallets: []fakeWallet{oldestFirst, newer}, wantID: "w-main", want: want},
		"tie winner listed first":             {wallets: []fakeWallet{{id: "w-a", created: "1700000000", accounts: main.accounts}, {id: "w-b", created: "1700000000", accounts: newer.accounts}}, wantID: "w-a", want: want},
		"only the nanos differ, listed first": {wallets: []fakeWallet{nanoOld, nanoNew}, wantID: "w-b", want: want},
		"only the nanos differ, listed last":  {wallets: []fakeWallet{nanoNew, nanoOld}, wantID: "w-b", want: want},
		"account tie, winner listed first":    {wallets: tied(tieWinner, tieLoser), wantID: "w-tie", want: tieWant},
		"account tie, winner listed last":     {wallets: tied(tieLoser, tieWinner), wantID: "w-tie", want: tieWant},
	} {
		t.Run(name, func(t *testing.T) {
			serveOrg(t, f, orgReplies{wallets: tc.wallets})
			got, err := ResolveWallet(context.Background(), walletConfig(t, f), tc.walletID)
			require.NoError(t, err)
			assert.Equal(t, tc.wantID, got.ID)
			assert.Equal(t, tc.want, got.Accounts)
		})
	}
}

func TestResolveWallet_ClassifiesFailures(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	evm := f.keys()[evmKeyID]
	one := func(accounts ...map[string]any) []fakeWallet {
		return []fakeWallet{{id: "w-1", created: "1700000000", accounts: accounts}}
	}
	var fullPage []fakeWallet
	var manyAccounts []map[string]any
	// Every entry but these is usable, so only the full page itself can fail the resolve.
	manyAccounts = append(manyAccounts, account(evm.SignWith, evm.PublicKey, AddressFormatEthereum, "1"))
	for i := range listLimit {
		fullPage = append(fullPage, fakeWallet{id: fmt.Sprintf("w-%03d", i), created: "1700000000"})
		if i > 0 {
			manyAccounts = append(manyAccounts, account(fmt.Sprintf("bc1-%03d", i), "", "ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH", "1"))
		}
	}
	for name, tc := range map[string]struct {
		org      orgReplies
		walletID string
		rejected bool
	}{
		"named wallet not in org":      {walletID: "w-missing", rejected: true},
		"org holds no wallet":          {org: orgReplies{wallets: []fakeWallet{}}, rejected: true},
		"unusable public key":          {org: orgReplies{wallets: one(account(evm.SignWith, "zz", AddressFormatEthereum, "1"))}, rejected: true},
		"root credential":              {org: orgReplies{whoamiBody: `{"organizationId":"org-verifier","userId":"root"}`}, rejected: true},
		"other org":                    {org: orgReplies{whoamiBody: `{"organizationId":"org-settler","userId":"agent"}`}, rejected: true},
		"whoami without user":          {org: orgReplies{whoamiBody: `{"organizationId":"org-verifier"}`}},
		"no root quorum":               {org: orgReplies{orgBody: `{"organizationData":{}}`}},
		"unauthorized":                 {org: orgReplies{whoamiStatus: 401}, rejected: true},
		"forbidden":                    {org: orgReplies{whoamiStatus: 403}, rejected: true},
		"bad request":                  {org: orgReplies{whoamiStatus: 400}, rejected: true},
		"not found":                    {org: orgReplies{whoamiStatus: 404}, rejected: true},
		"request timeout":              {org: orgReplies{whoamiStatus: 408}},
		"rate limited":                 {org: orgReplies{whoamiStatus: 429}},
		"whoami server error":          {org: orgReplies{whoamiStatus: 503}},
		"undecodable whoami":           {org: orgReplies{whoamiBody: `not json`}},
		"wallet listing forbidden":     {org: orgReplies{walletStatus: 403}, rejected: true},
		"wallet listing outage":        {org: orgReplies{walletStatus: 503}},
		"account listing outage":       {org: orgReplies{accountStatus: 503}},
		"account listed without a key": {org: orgReplies{wallets: one(account(evm.SignWith, "", AddressFormatEthereum, "1"))}, rejected: true},
		"a full page of wallets":       {org: orgReplies{wallets: fullPage}, rejected: true},
		"a full page of accounts":      {org: orgReplies{wallets: one(manyAccounts...)}, rejected: true},
		"wallets without createdAt":    {org: orgReplies{wallets: []fakeWallet{{id: "w-1"}, {id: "w-2"}}}, rejected: true},
		"accounts without createdAt":   {org: orgReplies{wallets: one(account(evm.SignWith, evm.PublicKey, AddressFormatEthereum, "1"), account("0x2", evm.PublicKey, AddressFormatEthereum, nil))}, rejected: true},
	} {
		t.Run(name, func(t *testing.T) {
			serveOrg(t, f, tc.org)
			_, err := ResolveWallet(context.Background(), walletConfig(t, f), tc.walletID)
			require.Error(t, err)
			assert.Equal(t, tc.rejected, errors.Is(err, ErrCredentialRejected), err.Error())
		})
	}
}

// A key pair that does not match, or any other client configuration error, fails the same way on
// every try, so it is definitive rather than an outage to retry.
func TestResolveWallet_BadClientConfigIsRejected(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	serveOrg(t, f, orgReplies{})
	cfg := walletConfig(t, f)
	otherPub, _ := generateP256Hex(t)
	cfg.APIPublicKey = otherPub
	_, err := ResolveWallet(context.Background(), cfg, "")
	assert.ErrorIs(t, err, ErrCredentialRejected)
}

func walletConfig(t *testing.T, f *fakeRawPayloadTurnkey) KeyBackendConfig {
	t.Helper()
	pub, priv := generateP256Hex(t)
	hc := f.ts.Client()
	hc.Timeout = 5 * time.Second
	return KeyBackendConfig{BaseURL: f.ts.URL, OrganizationID: "org-verifier", APIPublicKey: pub, APIPrivateKey: priv, HTTPClient: hc}
}

func TestKeyBackend_ConsensusNeededIsTerminal(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/public/v1/submit/sign_raw_payload", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(activityEnvelope{Activity: activity{ID: "act-c", Status: "ACTIVITY_STATUS_CONSENSUS_NEEDED"}})
	})
	f.ts.Config.Handler = mux
	b := newTestKeyBackend(t, f)

	start := time.Now()
	_, err := b.SignTypedData(context.Background(), releaseWitness(42161), evmKeyID, "eip155:42161")
	require.Error(t, err)
	assert.ErrorContains(t, err, "needs consensus approval")
	assert.ErrorIs(t, err, ErrTerminal)
	assert.Less(t, time.Since(start), time.Second)
}

func TestKeyBackend_SolanaRefusesNon32ByteMessage(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	b := newTestKeyBackend(t, f)

	_, err := b.Sign(context.Background(), make([]byte, 64), solanaKeyID, "solana:x")
	assert.ErrorContains(t, err, "expected a 32-byte digest")
	assert.Empty(t, f.recorded())
}

func TestKeyBackend_RefusesADomainMemberItCannotCarry(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	b := newTestKeyBackend(t, f)
	td := releaseWitness(1)
	td.Types["EIP712Domain"] = append(td.Types["EIP712Domain"], apitypes.Type{Name: "salt", Type: "bytes32"})
	td.Domain.Salt = "0x" + strings.Repeat("00", 32)

	_, err := b.SignTypedData(context.Background(), td, evmKeyID, "eip155:1")
	require.Error(t, err)
	assert.Empty(t, f.recorded())
}

// A 408 is Turnkey giving up on the request, so signing retries it like a 429 or a 5xx.
func TestClassify_RequestTimeoutIsTransient(t *testing.T) {
	assert.True(t, classify(http.StatusRequestTimeout, "sign", nil).Transient)
	assert.False(t, classify(http.StatusForbidden, "sign", nil).Transient)
}

// A policy denial can come back as a completed request whose activity is REJECTED rather than as
// an HTTP 4xx, and a caller must be able to tell it apart from an outage.
func TestKeyBackend_RejectedActivityIsMarked(t *testing.T) {
	f := newFakeRawPayloadTurnkey(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/public/v1/submit/sign_raw_payload", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(activityEnvelope{Activity: activity{ID: "act-r", Status: "ACTIVITY_STATUS_REJECTED"}})
	})
	f.ts.Config.Handler = mux

	_, err := newTestKeyBackend(t, f).SignTypedData(context.Background(), releaseWitness(42161), evmKeyID, "eip155:42161")
	assert.ErrorIs(t, err, ErrActivityRejected)
	assert.ErrorIs(t, err, ErrTerminal)
}
