// Package turnkey is the Atum signing helper that calls Turnkey to
// produce signed Base transactions for rUSD movement.
//
// Security model: the Turnkey-side policy attached to the API user is the
// authoritative guard for per-tx cap, daily cap, and the action denylist.
// As defense-in-depth this package additionally rejects any recipient that
// is not the configured AllowedRecipient before signing, so a
// misconfigured or absent Turnkey policy cannot let a transfer reach an
// arbitrary destination.
package turnkey

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// Config configures a Signer. APIPrivateKey is a P-256 private scalar in
// hex (no 0x prefix); APIPublicKey is its compressed-form hex companion.
// Credentials must be loaded from a secret manager at the caller layer —
// never committed.
type Config struct {
	BaseURL        string
	OrganizationID string
	APIPublicKey   string
	// Scrubbed at New(); aware.
	APIPrivateKey    string
	SignWith         string
	ChainID          *big.Int
	RUSDTokenAddress string
	// AllowedRecipient is the only address rUSD transfers may be sent to
	// (the custody deposit address). Any other recipient is rejected
	// before signing.
	AllowedRecipient string
	HTTPClient       *http.Client
	PollInterval     time.Duration
	PollTimeout      time.Duration
}

// Signer signs rUSD transfers on Base via Turnkey.
type Signer struct {
	apiClient
	cfg              Config
	tokenAddr        common.Address
	allowedRecipient common.Address
}

// GasParams captures the EIP-1559 gas knobs the caller supplies.
type GasParams struct {
	GasLimit             uint64
	MaxFeePerGas         *big.Int
	MaxPriorityFeePerGas *big.Int
}

// New constructs a Signer. Fails fast when any required field is missing
// or when the BaseURL is not https — a misconfigured http:// would
// transmit the X-Stamp header (including our P-256 signature) in
// cleartext.
func New(cfg Config) (*Signer, error) {
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
	if cfg.SignWith == "" {
		return nil, errors.New("turnkey: SignWith (wallet address) is required")
	}
	if !common.IsHexAddress(cfg.SignWith) {
		return nil, errors.New("turnkey: SignWith is not a valid hex address")
	}
	if cfg.ChainID == nil || cfg.ChainID.Sign() <= 0 {
		return nil, errors.New("turnkey: ChainID must be positive")
	}
	if cfg.RUSDTokenAddress == "" {
		return nil, errors.New("turnkey: RUSDTokenAddress is required")
	}
	if !common.IsHexAddress(cfg.RUSDTokenAddress) {
		return nil, errors.New("turnkey: RUSDTokenAddress is not a valid hex address")
	}
	if cfg.AllowedRecipient == "" {
		return nil, errors.New("turnkey: AllowedRecipient is required")
	}
	if !common.IsHexAddress(cfg.AllowedRecipient) {
		return nil, errors.New("turnkey: AllowedRecipient is not a valid hex address")
	}
	cfg.APIPrivateKey = ""
	return &Signer{
		apiClient:        api,
		cfg:              cfg,
		tokenAddr:        common.HexToAddress(cfg.RUSDTokenAddress),
		allowedRecipient: common.HexToAddress(cfg.AllowedRecipient),
	}, nil
}

// SignRusdTransfer asks Turnkey to sign an ERC-20 rUSD transfer on Base
// from the configured settler wallet to `to` for `amount` (token-smallest
// units). nonce and gas are caller-supplied; the policy attached to the
// Turnkey API user enforces destination + per-tx cap + daily cap.
//
// timestampMs is the activity timestamp Turnkey records and includes in
// its body fingerprint. The caller MUST supply a value that is stable
// across retries of the same logical transfer — Turnkey dedupes
// activities by full POST body, so a changed timestamp produces a NEW
// `sign_transaction` activity instead of returning the cached one. The
// workflow that calls this is expected to persist the timestamp on the
// rebalance row on first attempt and reuse it on every retry.
//
// Returns the canonical EIP-1559 signed transaction bytes
// (type byte 0x02 || RLP(signed fields)) ready for broadcast.
func (s *Signer) SignRusdTransfer(
	ctx context.Context, to common.Address, amount *big.Int, nonce uint64, gas GasParams, timestampMs int64,
) ([]byte, error) {
	if amount == nil || amount.Sign() <= 0 {
		return nil, errors.New("turnkey: amount must be positive")
	}
	if amount.BitLen() > 256 {
		return nil, errors.New("turnkey: amount overflows uint256")
	}
	if gas.MaxFeePerGas == nil || gas.MaxPriorityFeePerGas == nil {
		return nil, errors.New("turnkey: gas MaxFeePerGas/MaxPriorityFeePerGas required")
	}
	if gas.GasLimit == 0 {
		return nil, errors.New("turnkey: gas GasLimit must be positive")
	}
	if timestampMs <= 0 {
		return nil, errors.New("turnkey: timestampMs must be positive (caller supplies a retry-stable value)")
	}
	if to != s.allowedRecipient {
		return nil, &Error{Op: "sign", Cause: fmt.Errorf("turnkey: recipient %s is not the allowlisted custody address %s", to.Hex(), s.allowedRecipient.Hex())}
	}
	calldata := erc20TransferCalldata(to, amount)
	unsigned, err := encodeUnsignedEIP1559(s.cfg.ChainID, nonce, gas, s.tokenAddr, calldata)
	if err != nil {
		return nil, err
	}
	body := signTxRequest{
		Type:           "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
		TimestampMs:    fmt.Sprintf("%d", timestampMs),
		OrganizationID: s.cfg.OrganizationID,
		Parameters: signTxParameters{
			SignWith:            s.cfg.SignWith,
			Type:                "TRANSACTION_TYPE_ETHEREUM",
			UnsignedTransaction: hex.EncodeToString(unsigned),
		},
	}
	act, err := s.submit(ctx, "/public/v1/submit/sign_transaction", body)
	if err != nil {
		return nil, err
	}
	act, err = s.awaitCompletion(ctx, act, "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", s.cfg.SignWith, true)
	if err != nil {
		return nil, err
	}
	signedHex := act.Result.SignTransactionResult.SignedTransaction
	if signedHex == "" {
		return nil, &Error{Op: "sign", Cause: errors.New("turnkey: empty signedTransaction in completed activity")}
	}
	signedHex = strings.TrimPrefix(signedHex, "0x")
	out, err := hex.DecodeString(signedHex)
	if err != nil {
		return nil, &Error{Op: "sign", Cause: fmt.Errorf("turnkey: decode signedTransaction: %w", err)}
	}
	if err := s.verifySignedTx(out, calldata, nonce, gas); err != nil {
		return nil, err
	}
	return out, nil
}

// verifySignedTx parses Turnkey's response bytes and asserts every field
// of the signed transaction matches what we asked it to sign — type,
// chainID, destination contract, zero value, calldata, nonce, all three
// gas fields — and that the recovered sender is the configured SignWith
// wallet. Catches response substitution (Turnkey-side bug, MITM, or
// substituted proxy), including a swapped gas price that would drain the
// settler's native balance.
func (s *Signer) verifySignedTx(signed []byte, expectedCalldata []byte, nonce uint64, gas GasParams) error {
	var tx types.Transaction
	if err := tx.UnmarshalBinary(signed); err != nil {
		return &Error{Op: "verify", Cause: fmt.Errorf("turnkey: decode signed tx: %w", err)}
	}
	if tx.Type() != types.DynamicFeeTxType {
		return &Error{Op: "verify", Cause: fmt.Errorf("turnkey: returned tx is not EIP-1559 (type=%d)", tx.Type())}
	}
	if tx.ChainId().Cmp(s.cfg.ChainID) != 0 {
		return &Error{Op: "verify", Cause: fmt.Errorf("turnkey: chainID mismatch: got %s want %s", tx.ChainId(), s.cfg.ChainID)}
	}
	if tx.To() == nil || *tx.To() != s.tokenAddr {
		return &Error{Op: "verify", Cause: errors.New("turnkey: destination contract mismatch")}
	}
	if tx.Value().Sign() != 0 {
		return &Error{Op: "verify", Cause: fmt.Errorf("turnkey: non-zero value field %s", tx.Value())}
	}
	if !bytes.Equal(tx.Data(), expectedCalldata) {
		return &Error{Op: "verify", Cause: errors.New("turnkey: calldata mismatch")}
	}
	if tx.Nonce() != nonce {
		return &Error{Op: "verify", Cause: fmt.Errorf("turnkey: nonce mismatch: got %d want %d", tx.Nonce(), nonce)}
	}
	if tx.Gas() != gas.GasLimit {
		return &Error{Op: "verify", Cause: fmt.Errorf("turnkey: gas limit mismatch: got %d want %d", tx.Gas(), gas.GasLimit)}
	}
	if tx.GasFeeCap().Cmp(gas.MaxFeePerGas) != 0 {
		return &Error{Op: "verify", Cause: fmt.Errorf("turnkey: maxFeePerGas mismatch: got %s want %s", tx.GasFeeCap(), gas.MaxFeePerGas)}
	}
	if tx.GasTipCap().Cmp(gas.MaxPriorityFeePerGas) != 0 {
		return &Error{Op: "verify", Cause: fmt.Errorf("turnkey: maxPriorityFeePerGas mismatch: got %s want %s", tx.GasTipCap(), gas.MaxPriorityFeePerGas)}
	}
	sender, err := types.Sender(types.NewLondonSigner(s.cfg.ChainID), &tx)
	if err != nil {
		return &Error{Op: "verify", Cause: fmt.Errorf("turnkey: recover sender: %w", err)}
	}
	if sender != common.HexToAddress(s.cfg.SignWith) {
		return &Error{Op: "verify", Cause: fmt.Errorf("turnkey: recovered sender %s != SignWith %s", sender.Hex(), s.cfg.SignWith)}
	}
	return nil
}

// --- Turnkey request/response shapes ---

type signTxRequest struct {
	Type           string           `json:"type"`
	TimestampMs    string           `json:"timestampMs"`
	OrganizationID string           `json:"organizationId"`
	Parameters     signTxParameters `json:"parameters"`
}

type signTxParameters struct {
	SignWith            string `json:"signWith"`
	Type                string `json:"type"`
	UnsignedTransaction string `json:"unsignedTransaction"`
}
