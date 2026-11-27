package turnkey

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	ethcrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// ErrDigestSigningRefused is returned when a caller asks for a bare digest on a secp256k1 key.
// Every secp256k1 signature this backend produces goes through the EIP-712 typed-data activity,
// because that is the only request shape a field-level Turnkey policy can read.
var ErrDigestSigningRefused = errors.New("turnkey: secp256k1 keys sign EIP-712 typed data only, never a bare digest")

// KeyBackendConfig configures a KeyBackend. The API key pair follows the same rules as Config:
// a P-256 scalar in hex and its compressed public key, loaded from a secret manager.
type KeyBackendConfig struct {
	BaseURL        string
	OrganizationID string
	APIPublicKey   string
	// Parsed at NewKeyBackend and not retained as a string. The caller's copy is its own to clear.
	APIPrivateKey string
	// Keys maps the caller's key id to the Turnkey wallet account that signs for it.
	Keys         map[string]KeyConfig
	HTTPClient   *http.Client
	PollInterval time.Duration
	PollTimeout  time.Duration
}

// KeyConfig names one Turnkey wallet account.
type KeyConfig struct {
	// SignWith is the account address Turnkey signs with: 0x hex for EVM, T base58 for Tron, and
	// base58 for Solana.
	SignWith string
	// PublicKey is the account's public key in hex, as Turnkey lists it: a compressed or
	// uncompressed secp256k1 point, or a 32-byte ed25519 key. Every signature is verified
	// against it before it is returned.
	PublicKey string
}

type backendKey struct {
	signWith   string
	secp256k1  *ecdsa.PublicKey
	ed25519    ed25519.PublicKey
	evmAddress common.Address
}

// KeyBackend signs with Turnkey-held keys. It satisfies the SigningKeyBackend and
// TypedDataSigner interfaces a signing-key manager consumes: Sign, GetPublicKey,
// IsHealthy and SignTypedData.
//
// secp256k1 keys (eip155:*, tron:*) sign only through SignTypedData, which Turnkey receives as a
// PAYLOAD_ENCODING_EIP712 activity. ed25519 keys (solana:*) sign a raw payload through Sign.
type KeyBackend struct {
	apiClient
	keys map[string]backendKey
}

// NewKeyBackend validates the configuration and parses every configured public key, so a
// mistyped key fails at startup rather than on the first payment.
func NewKeyBackend(cfg KeyBackendConfig) (*KeyBackend, error) {
	api, err := newAPIClient(apiConfig{
		BaseURL:        cfg.BaseURL,
		OrganizationID: cfg.OrganizationID,
		APIPublicKey:   cfg.APIPublicKey,
		APIPrivateKey:  cfg.APIPrivateKey,
		HTTPClient:     cfg.HTTPClient,
		PollInterval:   cfg.PollInterval,
		PollTimeout:    cfg.PollTimeout,
	})
	if err != nil {
		return nil, err
	}
	if len(cfg.Keys) == 0 {
		return nil, errors.New("turnkey: at least one key is required")
	}
	keys := make(map[string]backendKey, len(cfg.Keys))
	for id, kc := range cfg.Keys {
		k, err := parseBackendKey(kc)
		if err != nil {
			return nil, fmt.Errorf("turnkey: key %q: %w", id, err)
		}
		keys[id] = k
	}
	return &KeyBackend{apiClient: api, keys: keys}, nil
}

// ParsePublicKey decodes a hex public key as Turnkey lists it: 32 bytes is ed25519, 33 or 65 bytes
// is a secp256k1 point. It returns ed25519.PublicKey or *ecdsa.PublicKey.
func ParsePublicKey(pubHex string) (crypto.PublicKey, error) {
	raw, err := hex.DecodeString(strings.TrimPrefix(pubHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("public key is not hex: %w", err)
	}
	switch len(raw) {
	case ed25519.PublicKeySize:
		return ed25519.PublicKey(raw), nil
	case 33:
		return ethcrypto.DecompressPubkey(raw)
	case 65:
		return ethcrypto.UnmarshalPubkey(raw)
	default:
		return nil, fmt.Errorf("public key is %d bytes, expected 32 (ed25519), 33 or 65 (secp256k1)", len(raw))
	}
}

func parseBackendKey(kc KeyConfig) (backendKey, error) {
	if strings.TrimSpace(kc.SignWith) == "" {
		return backendKey{}, errors.New("SignWith is required")
	}
	pub, err := ParsePublicKey(kc.PublicKey)
	if err != nil {
		return backendKey{}, err
	}
	if ed, ok := pub.(ed25519.PublicKey); ok {
		return backendKey{signWith: kc.SignWith, ed25519: ed}, nil
	}
	secp := pub.(*ecdsa.PublicKey)
	addr := ethcrypto.PubkeyToAddress(*secp)
	// An 0x SignWith is checkable here. A Tron base58 one is checked by the first signature,
	// which must recover to this public key.
	if strings.HasPrefix(kc.SignWith, "0x") && !strings.EqualFold(kc.SignWith, addr.Hex()) {
		return backendKey{}, fmt.Errorf("SignWith %s is not the address of PublicKey (%s)", kc.SignWith, addr.Hex())
	}
	return backendKey{signWith: kc.SignWith, secp256k1: secp, evmAddress: addr}, nil
}

func (b *KeyBackend) key(keyID, chainID string) (backendKey, error) {
	k, ok := b.keys[keyID]
	if !ok {
		return backendKey{}, fmt.Errorf("turnkey: no key configured for %q (chain %s)", keyID, chainID)
	}
	wantEd := strings.HasPrefix(chainID, "solana:")
	if wantEd != (k.ed25519 != nil) {
		return backendKey{}, fmt.Errorf("turnkey: key %q is the wrong curve for chain %s", keyID, chainID)
	}
	return k, nil
}

// Sign signs message as a raw ed25519 payload. It refuses every secp256k1 key with
// ErrDigestSigningRefused: the verifier sub-org denies raw digest signing on secp256k1, and
// refusing here keeps a wiring bug from reaching Turnkey as a policy denial.
func (b *KeyBackend) Sign(ctx context.Context, message []byte, keyID string, chainID string) ([]byte, error) {
	k, err := b.key(keyID, chainID)
	if err != nil {
		return nil, err
	}
	if k.ed25519 == nil {
		return nil, ErrDigestSigningRefused
	}
	// The Solana release and refund hashes are 32 bytes. Anything else is a wiring bug, and
	// refusing it keeps this path from signing arbitrary bytes.
	if len(message) != 32 {
		return nil, fmt.Errorf("turnkey: ed25519 message is %d bytes, expected a 32-byte digest", len(message))
	}
	res, err := b.signRawPayload(ctx, signRawPayloadParameters{
		SignWith:     k.signWith,
		Payload:      hex.EncodeToString(message),
		Encoding:     "PAYLOAD_ENCODING_HEXADECIMAL",
		HashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
	})
	if err != nil {
		return nil, err
	}
	sig, err := decodeParts(res.R, res.S)
	if err != nil {
		return nil, err
	}
	if !ed25519.Verify(k.ed25519, message, sig) {
		return nil, &Error{Op: "verify", Cause: fmt.Errorf("turnkey: ed25519 signature from %s does not verify against the configured public key", k.signWith)}
	}
	return sig, nil
}

// SignTypedData signs EIP-712 typed data on a secp256k1 key through a PAYLOAD_ENCODING_EIP712
// activity, so Turnkey can apply policy to the primary type, the domain and the message fields.
//
// The payload is canonicalized first: address members are lowercased and the domain chain id is
// written as a decimal number, which fixes the form policy literals are compared against. The
// digest of the canonical payload must equal the digest of typedData, and the returned signature
// must recover to the configured public key, or nothing is returned.
//
// The result is 65 bytes, r || s || v, with low s and v in {27, 28}.
func (b *KeyBackend) SignTypedData(ctx context.Context, typedData apitypes.TypedData, keyID string, chainID string) ([]byte, error) {
	k, err := b.key(keyID, chainID)
	if err != nil {
		return nil, err
	}
	if k.secp256k1 == nil {
		return nil, fmt.Errorf("turnkey: key %q is ed25519 and cannot sign EIP-712 typed data", keyID)
	}
	digest, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return nil, fmt.Errorf("turnkey: EIP-712 hash: %w", err)
	}
	payload, err := canonicalTypedDataJSON(typedData)
	if err != nil {
		return nil, err
	}
	var reparsed apitypes.TypedData
	if err := json.Unmarshal(payload, &reparsed); err != nil {
		return nil, fmt.Errorf("turnkey: canonical typed data does not parse: %w", err)
	}
	canonicalDigest, _, err := apitypes.TypedDataAndHash(reparsed)
	if err != nil {
		return nil, fmt.Errorf("turnkey: EIP-712 hash of canonical typed data: %w", err)
	}
	if !bytes.Equal(canonicalDigest, digest) {
		return nil, fmt.Errorf("turnkey: canonical typed data hashes to 0x%x, the struct to 0x%x", canonicalDigest, digest)
	}

	res, err := b.signRawPayload(ctx, signRawPayloadParameters{
		SignWith:     k.signWith,
		Payload:      string(payload),
		Encoding:     "PAYLOAD_ENCODING_EIP712",
		HashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
	})
	if err != nil {
		return nil, err
	}
	rs, err := decodeParts(res.R, res.S)
	if err != nil {
		return nil, err
	}
	v, err := hex.DecodeString(strings.TrimPrefix(res.V, "0x"))
	if err != nil || len(v) != 1 {
		return nil, &Error{Op: "verify", Cause: fmt.Errorf("turnkey: malformed recovery id %q", res.V)}
	}
	recID := v[0]
	if recID >= 27 {
		recID -= 27
	}
	if recID > 1 {
		return nil, &Error{Op: "verify", Cause: fmt.Errorf("turnkey: recovery id %d out of range", v[0])}
	}
	sig := normalizeLowS(append(rs, recID))
	pub, err := ethcrypto.SigToPub(digest, sig)
	if err != nil {
		return nil, &Error{Op: "verify", Cause: fmt.Errorf("turnkey: recover signer: %w", err)}
	}
	if got := ethcrypto.PubkeyToAddress(*pub); got != k.evmAddress {
		return nil, &Error{Op: "verify", Cause: fmt.Errorf("turnkey: signature recovers to %s, expected %s", got.Hex(), k.evmAddress.Hex())}
	}
	sig[64] += 27
	return sig, nil
}

// GetPublicKey returns the configured public key: *ecdsa.PublicKey for secp256k1 chains,
// ed25519.PublicKey for Solana.
func (b *KeyBackend) GetPublicKey(_ context.Context, keyID string, chainID string) (crypto.PublicKey, error) {
	k, err := b.key(keyID, chainID)
	if err != nil {
		return nil, err
	}
	if k.ed25519 != nil {
		return k.ed25519, nil
	}
	return k.secp256k1, nil
}

// IsHealthy reports whether the backend is configured. It makes no network call, so a health
// probe cannot spend the sub-org's request budget.
func (b *KeyBackend) IsHealthy(context.Context) bool {
	return len(b.keys) > 0
}

type signRawPayloadRequest struct {
	Type           string                   `json:"type"`
	TimestampMs    string                   `json:"timestampMs"`
	OrganizationID string                   `json:"organizationId"`
	Parameters     signRawPayloadParameters `json:"parameters"`
}

type signRawPayloadParameters struct {
	SignWith     string `json:"signWith"`
	Payload      string `json:"payload"`
	Encoding     string `json:"encoding"`
	HashFunction string `json:"hashFunction"`
}

const signRawPayloadActivity = "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2"

func (b *KeyBackend) signRawPayload(ctx context.Context, p signRawPayloadParameters) (signRawPayloadResult, error) {
	body := signRawPayloadRequest{
		Type:           signRawPayloadActivity,
		TimestampMs:    fmt.Sprintf("%d", time.Now().UnixMilli()),
		OrganizationID: b.organizationID,
		Parameters:     p,
	}
	act, err := b.submit(ctx, "/public/v1/submit/sign_raw_payload", body)
	if err != nil {
		return signRawPayloadResult{}, err
	}
	act, err = b.awaitCompletion(ctx, act, signRawPayloadActivity, p.SignWith, false)
	if err != nil {
		return signRawPayloadResult{}, err
	}
	return act.Result.SignRawPayloadResult, nil
}

// decodeParts joins Turnkey's hex r and s into 64 bytes.
func decodeParts(rHex, sHex string) ([]byte, error) {
	r, errR := hex.DecodeString(strings.TrimPrefix(rHex, "0x"))
	s, errS := hex.DecodeString(strings.TrimPrefix(sHex, "0x"))
	if errR != nil || errS != nil || len(r) != 32 || len(s) != 32 {
		return nil, &Error{Op: "verify", Cause: fmt.Errorf("turnkey: malformed signature parts r=%q s=%q", rHex, sHex)}
	}
	return append(r, s...), nil
}

var (
	secp256k1N     = ethcrypto.S256().Params().N
	secp256k1HalfN = new(big.Int).Rsh(secp256k1N, 1)
)

// normalizeLowS rewrites a 65-byte r || s || recid signature to low s, flipping the recovery id
// to match. The escrow rejects high-s signatures.
func normalizeLowS(sig []byte) []byte {
	s := new(big.Int).SetBytes(sig[32:64])
	if s.Cmp(secp256k1HalfN) <= 0 {
		return sig
	}
	s.Sub(secp256k1N, s)
	out := make([]byte, 65)
	copy(out[:32], sig[:32])
	s.FillBytes(out[32:64])
	out[64] = sig[64] ^ 1
	return out
}

// canonicalTypedDataJSON renders typed data the way the policy literals expect it: every
// address-typed member lowercased, the domain verifying contract lowercased, and the domain chain
// id as a decimal JSON number. None of these change the EIP-712 digest. Any other domain member
// (salt) is dropped, which changes the digest, so SignTypedData refuses it before sending.
func canonicalTypedDataJSON(td apitypes.TypedData) ([]byte, error) {
	message, err := canonicalValue(td.Types, td.PrimaryType, map[string]interface{}(td.Message))
	if err != nil {
		return nil, err
	}
	domain := map[string]interface{}{}
	for _, f := range td.Types["EIP712Domain"] {
		switch f.Name {
		case "name":
			domain["name"] = td.Domain.Name
		case "version":
			domain["version"] = td.Domain.Version
		case "chainId":
			if td.Domain.ChainId == nil {
				return nil, errors.New("turnkey: EIP712Domain declares chainId but the domain has none")
			}
			domain["chainId"] = json.Number((*big.Int)(td.Domain.ChainId).String())
		case "verifyingContract":
			domain["verifyingContract"] = strings.ToLower(td.Domain.VerifyingContract)
		}
	}
	out, err := json.Marshal(map[string]interface{}{
		"types":       td.Types,
		"primaryType": td.PrimaryType,
		"domain":      domain,
		"message":     message,
	})
	if err != nil {
		return nil, fmt.Errorf("turnkey: marshal canonical typed data: %w", err)
	}
	return out, nil
}

func canonicalValue(types apitypes.Types, typ string, v interface{}) (interface{}, error) {
	if strings.HasSuffix(typ, "]") {
		elem := typ[:strings.LastIndex(typ, "[")]
		items, ok := v.([]interface{})
		if !ok {
			return nil, fmt.Errorf("turnkey: %s value is %T, not an array", typ, v)
		}
		out := make([]interface{}, len(items))
		for i, item := range items {
			c, err := canonicalValue(types, elem, item)
			if err != nil {
				return nil, err
			}
			out[i] = c
		}
		return out, nil
	}
	if fields, ok := types[typ]; ok {
		m, ok := v.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("turnkey: %s value is %T, not a struct", typ, v)
		}
		out := make(map[string]interface{}, len(fields))
		for _, f := range fields {
			c, err := canonicalValue(types, f.Type, m[f.Name])
			if err != nil {
				return nil, fmt.Errorf("member %s: %w", f.Name, err)
			}
			out[f.Name] = c
		}
		return out, nil
	}
	if typ == "address" {
		s, ok := v.(string)
		if !ok || !common.IsHexAddress(s) {
			return nil, fmt.Errorf("turnkey: address member is %v, not a hex address", v)
		}
		return strings.ToLower(s), nil
	}
	return v, nil
}

// ErrCredentialRejected marks a definitive ResolveWallet failure: Turnkey answered and refused the
// configuration. That is a 4xx other than 408 or 429, a credential from another organization, a
// root credential, or a wallet the organization does not hold. Any other error is an outage and
// says nothing about the configuration.
var ErrCredentialRejected = errors.New("turnkey: configuration rejected")

// resolveTimeout bounds one ResolveWallet call. A caller that resolves its wallet cannot sign
// without the answer, so a slow but healthy Turnkey gets room.
const resolveTimeout = 20 * time.Second

type whoamiResponse struct {
	OrganizationID string `json:"organizationId"`
	UserID         string `json:"userId"`
}

type getOrganizationResponse struct {
	OrganizationData struct {
		RootQuorum struct {
			Threshold *int     `json:"threshold"`
			UserIDs   []string `json:"userIds"`
		} `json:"rootQuorum"`
	} `json:"organizationData"`
}

// turnkeyTime is Turnkey's timestamp: seconds and nanos, each a JSON string or number.
type turnkeyTime struct {
	Seconds json.Number `json:"seconds"`
	Nanos   json.Number `json:"nanos"`
}

// unix reads the timestamp, reporting false when Turnkey sent none.
func (t turnkeyTime) unix() (int64, int64, bool) {
	s, err := t.Seconds.Int64()
	if err != nil {
		return 0, 0, false
	}
	n, _ := t.Nanos.Int64()
	return s, n, true
}

type listedWallet struct {
	WalletID  string      `json:"walletId"`
	CreatedAt turnkeyTime `json:"createdAt"`
}

type listWalletsResponse struct {
	Wallets []listedWallet `json:"wallets"`
}

type listedAccount struct {
	Address       string      `json:"address"`
	PublicKey     string      `json:"publicKey"`
	AddressFormat string      `json:"addressFormat"`
	CreatedAt     turnkeyTime `json:"createdAt"`
}

type listWalletAccountsResponse struct {
	Accounts []listedAccount `json:"accounts"`
}

// Turnkey address formats, the keys of Wallet.Accounts.
const (
	AddressFormatEthereum = "ADDRESS_FORMAT_ETHEREUM"
	AddressFormatTron     = "ADDRESS_FORMAT_TRON"
	AddressFormatSolana   = "ADDRESS_FORMAT_SOLANA"
)

// Wallet is one Turnkey wallet and its signing account per address format.
type Wallet struct {
	ID       string
	Accounts map[string]KeyConfig
}

// ResolveWallet checks the credential (its organization is the configured one and it is not a root
// user, which bypasses every policy) and returns the wallet walletID, or the organization's oldest
// wallet when walletID is empty. Each address format this backend signs for
// (Ethereum, Tron, Solana) maps to the wallet's oldest account of that format, so adding a wallet
// or an account later never changes which key signs. cfg.Keys is ignored. A bad configuration, a
// refusal, or a listing it cannot pick from (a walletID the organization does not hold, a full page,
// an entry without its createdAt or public key) wraps ErrCredentialRejected. Every other failure is
// an outage, returned unwrapped.
func ResolveWallet(ctx context.Context, cfg KeyBackendConfig, walletID string) (Wallet, error) {
	api, err := newAPIClient(apiConfig{
		BaseURL:        cfg.BaseURL,
		OrganizationID: cfg.OrganizationID,
		APIPublicKey:   cfg.APIPublicKey,
		APIPrivateKey:  cfg.APIPrivateKey,
		HTTPClient:     cfg.HTTPClient,
	})
	if err != nil {
		// A malformed key pair or URL fails the same way on every try.
		return Wallet{}, fmt.Errorf("%w: %v", ErrCredentialRejected, err)
	}
	ctx, cancel := context.WithTimeout(ctx, resolveTimeout)
	defer cancel()
	if err := api.checkCredential(ctx); err != nil {
		return Wallet{}, err
	}
	wallets, err := api.listWallets(ctx)
	if err != nil {
		return Wallet{}, err
	}
	if len(wallets) >= listLimit {
		return Wallet{}, fmt.Errorf("%w: organization %q lists %d or more wallets, so the oldest may be on another page", ErrCredentialRejected, api.organizationID, listLimit)
	}
	var chosen *listedWallet
	for i := range wallets {
		w := &wallets[i]
		if walletID != "" {
			if w.WalletID == walletID {
				chosen = w
				break
			}
			continue
		}
		if chosen == nil {
			chosen = w
			continue
		}
		older, err := earlier(w.CreatedAt, w.WalletID, chosen.CreatedAt, chosen.WalletID)
		if err != nil {
			return Wallet{}, fmt.Errorf("%w: %v", ErrCredentialRejected, err)
		}
		if older {
			chosen = w
		}
	}
	if chosen == nil {
		if walletID != "" {
			return Wallet{}, fmt.Errorf("%w: wallet %q is not in organization %q", ErrCredentialRejected, walletID, api.organizationID)
		}
		return Wallet{}, fmt.Errorf("%w: organization %q holds no wallet", ErrCredentialRejected, api.organizationID)
	}
	accounts, err := api.listAccounts(ctx, chosen.WalletID)
	if err != nil {
		return Wallet{}, err
	}
	if len(accounts) >= listLimit {
		return Wallet{}, fmt.Errorf("%w: wallet %q lists %d or more accounts, so the oldest may be on another page", ErrCredentialRejected, chosen.WalletID, listLimit)
	}
	oldest := map[string]listedAccount{}
	for _, a := range accounts {
		switch a.AddressFormat {
		case AddressFormatEthereum, AddressFormatTron, AddressFormatSolana:
		default:
			continue // a format this backend cannot sign for
		}
		prev, seen := oldest[a.AddressFormat]
		if !seen {
			oldest[a.AddressFormat] = a
			continue
		}
		older, err := earlier(a.CreatedAt, a.Address, prev.CreatedAt, prev.Address)
		if err != nil {
			return Wallet{}, fmt.Errorf("%w: %v", ErrCredentialRejected, err)
		}
		if older {
			oldest[a.AddressFormat] = a
		}
	}
	out := Wallet{ID: chosen.WalletID, Accounts: make(map[string]KeyConfig, len(oldest))}
	for format, a := range oldest {
		if a.PublicKey == "" {
			return Wallet{}, fmt.Errorf("%w: account %s was listed without a public key", ErrCredentialRejected, a.Address)
		}
		kc := KeyConfig{SignWith: a.Address, PublicKey: a.PublicKey}
		if _, err := parseBackendKey(kc); err != nil {
			return Wallet{}, fmt.Errorf("%w: account %s of wallet %q: %v", ErrCredentialRejected, a.Address, chosen.WalletID, err)
		}
		out.Accounts[format] = kc
	}
	return out, nil
}

// earlier reports whether the entry (t, id) was created before (u, uid), breaking a tie by id. It
// errors when either timestamp is missing, since the oldest entry could then not be told apart.
func earlier(t turnkeyTime, id string, u turnkeyTime, uid string) (bool, error) {
	ts, tn, ok := t.unix()
	if !ok {
		return false, fmt.Errorf("turnkey: %s was listed without a createdAt", id)
	}
	us, un, ok := u.unix()
	if !ok {
		return false, fmt.Errorf("turnkey: %s was listed without a createdAt", uid)
	}
	if ts != us {
		return ts < us, nil
	}
	if tn != un {
		return tn < un, nil
	}
	return id < uid, nil
}

// checkCredential runs whoami, requires the credential's organization to be the configured one,
// and refuses a root user.
func (c *apiClient) checkCredential(ctx context.Context) error {
	org := map[string]string{"organizationId": c.organizationID}

	var who whoamiResponse
	if err := c.query(ctx, "/public/v1/query/whoami", org, &who); err != nil {
		return err
	}
	if who.OrganizationID != c.organizationID {
		return fmt.Errorf("%w: the credential belongs to organization %q, not the configured %q", ErrCredentialRejected, who.OrganizationID, c.organizationID)
	}
	if who.UserID == "" {
		return &Error{Op: "whoami", Cause: errors.New("turnkey: whoami returned no userId, so the root check cannot run")}
	}
	var orgData getOrganizationResponse
	if err := c.query(ctx, "/public/v1/query/get_organization", org, &orgData); err != nil {
		return err
	}
	// A reply without a root quorum would let a root credential through unnoticed, so it is
	// reported rather than read as "no root users".
	if orgData.OrganizationData.RootQuorum.Threshold == nil {
		return &Error{Op: "get_organization", Cause: errors.New("turnkey: get_organization returned no root quorum, so the root check cannot run")}
	}
	for _, id := range orgData.OrganizationData.RootQuorum.UserIDs {
		if id == who.UserID {
			return fmt.Errorf("%w: the credential belongs to root user %q, which bypasses every policy", ErrCredentialRejected, who.UserID)
		}
	}
	return nil
}

// Turnkey pages list results. One page of the maximum size holds any verifier organization,
// which has one wallet with an account per chain family.
const listLimit = 100

var listPage = map[string]string{"limit": strconv.Itoa(listLimit)}

func (c *apiClient) listWallets(ctx context.Context) ([]listedWallet, error) {
	var out listWalletsResponse
	req := map[string]any{"organizationId": c.organizationID, "paginationOptions": listPage}
	if err := c.query(ctx, "/public/v1/query/list_wallets", req, &out); err != nil {
		return nil, err
	}
	return out.Wallets, nil
}

func (c *apiClient) listAccounts(ctx context.Context, walletID string) ([]listedAccount, error) {
	var out listWalletAccountsResponse
	req := map[string]any{"organizationId": c.organizationID, "walletId": walletID, "paginationOptions": listPage}
	if err := c.query(ctx, "/public/v1/query/list_wallet_accounts", req, &out); err != nil {
		return nil, err
	}
	return out.Accounts, nil
}

// query posts a read-only request and decodes the reply, wrapping ErrCredentialRejected on a 4xx
// other than 408 or 429: Turnkey received the request and refused it, so retrying cannot help.
func (c *apiClient) query(ctx context.Context, path string, body, out any) error {
	raw, err := c.post(ctx, path, body)
	if err != nil {
		var te *Error
		if errors.As(err, &te) && te.StatusCode/100 == 4 &&
			te.StatusCode != http.StatusRequestTimeout && te.StatusCode != http.StatusTooManyRequests {
			return fmt.Errorf("%w: %v", ErrCredentialRejected, err)
		}
		return err
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return &Error{Op: path, Cause: fmt.Errorf("turnkey: decode: %w", err)}
	}
	return nil
}
