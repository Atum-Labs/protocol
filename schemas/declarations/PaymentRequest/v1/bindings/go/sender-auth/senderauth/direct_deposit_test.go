package senderauth

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"testing"

	evmencoding "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/encoding"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

// The escrow's direct-deposit known answer (contracts/evm/conformance/direct-deposit-vectors.json),
// pinned against the real Escrow by Escrow.directDepositVectors.t.sol: chain 31337, escrow
// 0x...e5c0, owner 0x...A11cE, token 0x...70Ce, nonce 7, amount 1000e18, reserver 0x9139...,
// releaser 0x8374..., destination eip155:8453/erc20:0xaaaa@0xbbbb. Its depositRequestHash is
// keccak256("default-deposit-request-hash"), which is the v1 hash of a request whose request_id is
// that string.
var (
	vectorChainID   = big.NewInt(31337)
	vectorEscrow    = common.HexToAddress("0x000000000000000000000000000000000000e5c0")
	vectorDepositID = common.HexToHash("0xab346d06d4abffab74aa79d969ca268d9f19fdc3d621361434fa2516b2e703e8")
)

// vectorRequest is a PaymentRequest that names the known-answer deposit, with edit applied to its
// decoded members before encoding.
func vectorRequest(t *testing.T, edit func(map[string]any)) []byte {
	t.Helper()
	doc := map[string]any{
		"version":    "1.0",
		"request_id": "default-deposit-request-hash",
		"source": map[string]any{
			"asset_identifier": "eip155:31337/erc20:0x00000000000000000000000000000000000070Ce",
			"account":          "0x00000000000000000000000000000000000A11cE",
		},
		"destination": []any{map[string]any{
			"asset_identifier": "eip155:8453/erc20:0xaaaa",
			"account":          "0xbbbb",
		}},
		"fulfillment_amount":      "750000",
		"max_source_amount":       "1000000000000000000000",
		"quote_deadline":          "2030-01-01T00:00:00Z",
		"fulfillment_deadline":    "2030-01-01T00:10:00Z",
		"executor":                map[string]any{"deposit": "originator", "reserve": "settler", "fulfill": "originator"},
		"deposit_nonce":           "7",
		"escrow_contract_address": "0x000000000000000000000000000000000000e5c0",
		"quote_selector":          "0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb",
		"fulfillment_verifier": map[string]any{
			"account":  "0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9",
			"endpoint": "https://veri-fill.example.com",
		},
	}
	if edit != nil {
		edit(doc)
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	return raw
}

// contractVectors is the part of contracts/evm/conformance/direct-deposit-vectors.json this suite
// reads. Escrow.directDepositVectors.t.sol requires each value to be what the real Escrow accepts,
// stores or computes, so matching it is matching the contract.
type contractVectors struct {
	DepositID             string `json:"depositId"`
	DirectDepositCalldata string `json:"directDepositCalldata"`
	UnreservedDepositHash string `json:"unreservedDepositHash"`
}

func loadContractVectors(t *testing.T) contractVectors {
	t.Helper()
	// senderauth -> sender-auth -> go -> bindings -> v1 -> PaymentRequest -> declarations -> schemas
	path := filepath.Join("..", "..", "..", "..", "..", "..", "..", "..", "contracts", "evm", "conformance", "direct-deposit-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var v contractVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return v
}

func TestDeriveDirectDepositReproducesTheKnownAnswer(t *testing.T) {
	want := loadContractVectors(t)
	got, err := DeriveDirectDeposit(vectorRequest(t, nil), vectorChainID, vectorEscrow, DirectDepositHashV1)
	if err != nil {
		t.Fatalf("DeriveDirectDeposit: %v", err)
	}
	if got.ID != vectorDepositID || got.ID.Hex() != want.DepositID {
		t.Fatalf("deposit id = %s, want %s", got.ID, want.DepositID)
	}
	// The input is what the payer calls directDeposit with: the id holds only if it is the same.
	calldata, err := evmencoding.EncodeDirectDeposit(got.Input)
	if err != nil {
		t.Fatalf("EncodeDirectDeposit: %v", err)
	}
	if hexutil.Encode(calldata) != want.DirectDepositCalldata {
		t.Fatalf("directDeposit calldata = %s, want %s", hexutil.Encode(calldata), want.DirectDepositCalldata)
	}
	if got.UnreservedHash.Hex() != want.UnreservedDepositHash {
		t.Fatalf("unreserved deposit hash = %s, want %s", got.UnreservedHash, want.UnreservedDepositHash)
	}
}

// Under v1 the witness commits only the request_id, so a deadline or the fulfillment amount does not
// move the id; under v2 they do. Every member the id preimage takes moves it under both.
func TestDeriveDirectDepositBindsEachMember(t *testing.T) {
	set := func(value any, path ...string) func(map[string]any) {
		return func(doc map[string]any) {
			node := doc
			for _, key := range path[:len(path)-1] {
				switch next := node[key].(type) {
				case map[string]any:
					node = next
				case []any:
					node = next[0].(map[string]any)
				}
			}
			node[path[len(path)-1]] = value
		}
	}
	cases := []struct {
		name    string
		edit    func(map[string]any)
		movesV1 bool
	}{
		{"deposit_nonce", set("8", "deposit_nonce"), true},
		// The owner must be the root account that calls directDeposit: naming the access key that
		// signed the batch derives an id no deposit has.
		{"source account: the access key instead of the root account", set("0x00000000000000000000000000000000000B0b00", "source", "account"), true},
		{"source token", set("eip155:31337/erc20:0x00000000000000000000000000000000000070Cf", "source", "asset_identifier"), true},
		{"max_source_amount", set("999", "max_source_amount"), true},
		{"quote_selector (reserver)", set("0x0000000000000000000000000000000000009139", "quote_selector"), true},
		{"fulfillment_verifier.account (releaser)", set("0x0000000000000000000000000000000000008374", "fulfillment_verifier", "account"), true},
		{"destination account", set("0xcccc", "destination", "account"), true},
		{"request_id", set("another-request", "request_id"), true},
		{"quote_deadline", set("2030-01-01T00:01:00Z", "quote_deadline"), false},
		{"fulfillment_deadline", set("2030-01-01T00:20:00Z", "fulfillment_deadline"), false},
		{"fulfillment_amount", set("750001", "fulfillment_amount"), false},
	}
	for _, version := range []DirectDepositHashVersion{DirectDepositHashV1, DirectDepositHashV2} {
		base, err := DeriveDirectDeposit(vectorRequest(t, nil), vectorChainID, vectorEscrow, version)
		if err != nil {
			t.Fatalf("v%d base: %v", version, err)
		}
		for _, tc := range cases {
			t.Run(fmt.Sprintf("v%d/%s", version, tc.name), func(t *testing.T) {
				got, err := DeriveDirectDeposit(vectorRequest(t, tc.edit), vectorChainID, vectorEscrow, version)
				if err != nil {
					t.Fatalf("DeriveDirectDeposit: %v", err)
				}
				wantMove := tc.movesV1 || version == DirectDepositHashV2
				if moved := got.ID != base.ID; moved != wantMove {
					t.Fatalf("id moved = %v, want %v", moved, wantMove)
				}
			})
		}
	}
	v1, _ := DeriveDirectDeposit(vectorRequest(t, nil), vectorChainID, vectorEscrow, DirectDepositHashV1)
	v2, _ := DeriveDirectDeposit(vectorRequest(t, nil), vectorChainID, vectorEscrow, DirectDepositHashV2)
	if v1.ID == v2.ID {
		t.Fatal("v1 and v2 of one request derive the same id")
	}
}

// directDepositRefusal is a request DeriveDirectDeposit refuses, and the reason it must give. escrow
// overrides the escrow the deposit is derived under, nil meaning vectorEscrow.
type directDepositRefusal struct {
	name    string
	edit    func(map[string]any)
	version DirectDepositHashVersion
	reason  string
	escrow  *common.Address
}

// escrowOf is the escrow a refusal case derives under.
func (r directDepositRefusal) escrowOf() common.Address {
	if r.escrow != nil {
		return *r.escrow
	}
	return vectorEscrow
}

func directDepositRefusals() []directDepositRefusal {
	return []directDepositRefusal{
		{"a settler-executed deposit", func(d map[string]any) {
			d["executor"] = map[string]any{"deposit": "settler", "reserve": "settler", "fulfill": "originator"}
			delete(d, "deposit_nonce")
		}, DirectDepositHashV1, DirectDepositReasonExecutor, nil},
		{"no executor", func(d map[string]any) { delete(d, "executor"); delete(d, "deposit_nonce") }, DirectDepositHashV1, DirectDepositReasonExecutor, nil},
		// The settler reserves: the escrow's reserve() is the settler's to submit, so a request giving
		// that leg to the originator names a deposit payment-gw refuses (the Validate executor rule).
		{"reserve by the originator", func(d map[string]any) {
			d["executor"] = map[string]any{"deposit": "originator", "reserve": "originator", "fulfill": "originator"}
		}, DirectDepositHashV1, DirectDepositReasonExecutor, nil},
		{"executor as the string originator", func(d map[string]any) { d["executor"] = "originator" }, DirectDepositHashV1, DirectDepositReasonExecutor, nil},
		{"no deposit_nonce", func(d map[string]any) { delete(d, "deposit_nonce") }, DirectDepositHashV1, DirectDepositReasonDepositNonce, nil},
		{"a non-decimal deposit_nonce", func(d map[string]any) { d["deposit_nonce"] = "0x07" }, DirectDepositHashV1, DirectDepositReasonDepositNonce, nil},
		{"a signed deposit_nonce", func(d map[string]any) { d["deposit_nonce"] = "-7" }, DirectDepositHashV1, DirectDepositReasonDepositNonce, nil},
		{"a numeric deposit_nonce", func(d map[string]any) { d["deposit_nonce"] = 7 }, DirectDepositHashV1, DirectDepositReasonRequest, nil},
		{"an empty deposit_nonce", func(d map[string]any) { d["deposit_nonce"] = "" }, DirectDepositHashV1, DirectDepositReasonDepositNonce, nil},
		{"a deposit_nonce above uint256", func(d map[string]any) {
			d["deposit_nonce"] = new(big.Int).Lsh(big.NewInt(1), 256).String()
		}, DirectDepositHashV1, DirectDepositReasonDepositNonce, nil},
		{"an unknown version", nil, DirectDepositHashVersion(3), DirectDepositReasonVersion, nil},
		{"a native source asset", func(d map[string]any) {
			d["source"].(map[string]any)["asset_identifier"] = "eip155:31337/slip44:60"
		}, DirectDepositHashV1, DirectDepositReasonSource, nil},
		{"a source on another chain", func(d map[string]any) {
			d["source"].(map[string]any)["asset_identifier"] = "eip155:1/erc20:0x00000000000000000000000000000000000070Ce"
		}, DirectDepositHashV1, DirectDepositReasonSource, nil},
		{"a source account that is not an address", func(d map[string]any) {
			d["source"].(map[string]any)["account"] = "0xA11cE"
		}, DirectDepositHashV1, DirectDepositReasonSource, nil},
		{"the zero escrow", func(d map[string]any) {
			d["escrow_contract_address"] = "0x0000000000000000000000000000000000000000"
		}, DirectDepositHashV1, DirectDepositReasonEscrow, &common.Address{}},
		{"another escrow", func(d map[string]any) {
			d["escrow_contract_address"] = "0x000000000000000000000000000000000000e5c1"
		}, DirectDepositHashV1, DirectDepositReasonEscrow, nil},
		{"no quote_selector", func(d map[string]any) { delete(d, "quote_selector") }, DirectDepositHashV1, DirectDepositReasonQuoteSelector, nil},
		{"a quote_selector that is not an address", func(d map[string]any) { d["quote_selector"] = "0x9139" }, DirectDepositHashV1, DirectDepositReasonQuoteSelector, nil},
		{"a whitespace-padded quote_selector", func(d map[string]any) {
			d["quote_selector"] = " 0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb"
		}, DirectDepositHashV1, DirectDepositReasonQuoteSelector, nil},
		// The escrow refuses a zero reserver or releaser, so no deposit can carry one.
		{"a zero quote_selector", func(d map[string]any) {
			d["quote_selector"] = "0x0000000000000000000000000000000000000000"
		}, DirectDepositHashV1, DirectDepositReasonQuoteSelector, nil},
		{"a verifier account that is not an address", func(d map[string]any) {
			d["fulfillment_verifier"].(map[string]any)["account"] = "veri-fill"
		}, DirectDepositHashV1, DirectDepositReasonFulfillmentVerifier, nil},
		{"a zero verifier account", func(d map[string]any) {
			d["fulfillment_verifier"].(map[string]any)["account"] = "0x0000000000000000000000000000000000000000"
		}, DirectDepositHashV1, DirectDepositReasonFulfillmentVerifier, nil},
		{"no max_source_amount", func(d map[string]any) { delete(d, "max_source_amount") }, DirectDepositHashV1, DirectDepositReasonMaxSourceAmount, nil},
		{"a zero max_source_amount", func(d map[string]any) { d["max_source_amount"] = "0" }, DirectDepositHashV1, DirectDepositReasonMaxSourceAmount, nil},
		{"a sender_auth", func(d map[string]any) { d["sender_auth"] = map[string]any{} }, DirectDepositHashV1, DirectDepositReasonSenderAuth, nil},
		{"a null sender_auth", func(d map[string]any) { d["sender_auth"] = nil }, DirectDepositHashV1, DirectDepositReasonSenderAuth, nil},
		{"a request_id the v2 reader refuses, under v1 too", func(d map[string]any) { d["request_id"] = "has spaces" }, DirectDepositHashV1, DirectDepositReasonRequest, nil},
		{"two destination legs", func(d map[string]any) {
			d["destination"] = append(d["destination"].([]any), map[string]any{"asset_identifier": "eip155:8453/erc20:0xaaaa", "account": "0xdddd"})
		}, DirectDepositHashV1, DirectDepositReasonRequest, nil},
		{"a case twin of deposit_nonce", func(d map[string]any) { d["Deposit_Nonce"] = "8" }, DirectDepositHashV1, DirectDepositReasonRequest, nil},
	}
}

// A request that cannot name a direct deposit is refused with a bounded reason a consumer can tag
// metrics with, never with an id for a deposit nobody made.
func TestDeriveDirectDepositRefuses(t *testing.T) {
	cases := directDepositRefusals()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DeriveDirectDeposit(vectorRequest(t, tc.edit), vectorChainID, tc.escrowOf(), tc.version)
			var refusal *DirectDepositError
			if !errors.As(err, &refusal) {
				t.Fatalf("DeriveDirectDeposit = %v, want a *DirectDepositError", err)
			}
			if refusal.Reason != tc.reason {
				t.Fatalf("reason = %q, want %q (%v)", refusal.Reason, tc.reason, err)
			}
		})
	}
}
