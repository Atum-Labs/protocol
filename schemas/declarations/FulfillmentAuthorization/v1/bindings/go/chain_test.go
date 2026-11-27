package fulfillmentauthorization

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// ownerKey is Hardhat account #1: the key behind the contract wallet in these tests. The wallet's
// own address is the conformance settler's, which the fake chain says has code.
const ownerKey = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

const (
	settlerAddress = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
	tokenAddress   = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
	baseSepolia    = "eip155:84532"
)

var magicReturn = common.RightPadBytes([]byte{0x16, 0x26, 0xba, 0x7e}, 32)

// fakeChain is the chain reader the tests hand ValidateWithChain. It models what an ERC-1271 wallet
// does, not what the EVM does: that the real answer comes from a deployed wallet is the one thing
// no offline test can show (see the doc comment on ValidateWithChain).
type fakeChain struct {
	hasCode    map[string]bool
	hasCodeErr error
	callErr    error
	// wallet answers isValidSignature for a contract account.
	wallet func(digest [32]byte, signature []byte, caller string) ContractSignatureAnswer

	// servedNetwork, when set, is the only network the reader answers for; any other is an error,
	// as the interface requires of a reader.
	servedNetwork string

	hasCodeCalls  []string
	hasCodeBlocks []*big.Int
	isValidCalls  []isValidCall
}

type isValidCall struct {
	network, account, caller string
	digest                   [32]byte
	signature                []byte
	block                    *big.Int
}

func (f *fakeChain) HasCode(_ context.Context, network, account string, block *big.Int) (bool, error) {
	f.hasCodeCalls = append(f.hasCodeCalls, network+"/"+account)
	f.hasCodeBlocks = append(f.hasCodeBlocks, block)
	if f.servedNetwork != "" && network != f.servedNetwork {
		return false, errors.New("network " + network + " is not served")
	}
	return f.hasCode[account], f.hasCodeErr
}

func (f *fakeChain) IsValidSignatureFrom(_ context.Context, network, account string, digest [32]byte, signature []byte, caller string, block *big.Int) (ContractSignatureAnswer, error) {
	f.isValidCalls = append(f.isValidCalls, isValidCall{network, account, caller, digest, signature, block})
	if f.servedNetwork != "" && network != f.servedNetwork {
		return ContractSignatureAnswer{}, errors.New("network " + network + " is not served")
	}
	if f.callErr != nil {
		return ContractSignatureAnswer{}, f.callErr
	}
	return f.wallet(digest, signature, caller), nil
}

// ownerWallet is a single-owner wallet, as a Safe with threshold 1 answers: the signature is the
// owner's 65-byte signature over the digest, and only the token may ask.
func ownerWallet(t *testing.T) func([32]byte, []byte, string) ContractSignatureAnswer {
	t.Helper()
	key, err := crypto.HexToECDSA(ownerKey)
	if err != nil {
		t.Fatal(err)
	}
	owner := crypto.PubkeyToAddress(key.PublicKey)
	return func(digest [32]byte, signature []byte, caller string) ContractSignatureAnswer {
		if caller != tokenAddress || len(signature) != 65 {
			return ContractSignatureAnswer{Reverted: true}
		}
		sig := append([]byte(nil), signature...)
		sig[64] -= 27
		pub, err := crypto.SigToPub(digest[:], sig)
		if err != nil || crypto.PubkeyToAddress(*pub) != owner {
			return ContractSignatureAnswer{ReturnData: common.RightPadBytes([]byte{0xff, 0xff, 0xff, 0xff}, 32)}
		}
		return ContractSignatureAnswer{ReturnData: magicReturn}
	}
}

// contractChain says the settler has code and is the owner wallet.
func contractChain(t *testing.T) *fakeChain {
	t.Helper()
	return &fakeChain{hasCode: map[string]bool{settlerAddress: true}, wallet: ownerWallet(t)}
}

// withSignature replaces the signature of the conformance document, which the settler's key signed.
func withSignature(t *testing.T, signature string) []byte {
	t.Helper()
	doc := settlerSigned(t)
	doc["authorization"].(map[string]any)["signature"] = signature
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// ownerSigned is the conformance document with the owner key's signature instead of the settler's:
// what a contract-wallet settler publishes. Nothing about it recovers to message.from.
func ownerSigned(t *testing.T) []byte {
	t.Helper()
	doc := settlerSigned(t)
	authorization := doc["authorization"].(map[string]any)
	key, err := crypto.HexToECDSA(ownerKey)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := crypto.Sign(common.FromHex(authorization["message"].(string)), key)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27
	authorization["signature"] = hexutilEncode(sig)
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestValidateWithChainProvesContractSignature(t *testing.T) {
	t.Run("owner signature of a contract wallet", func(t *testing.T) {
		raw := ownerSigned(t)
		// The offline validator refuses it: the signature recovers to the owner, not the wallet.
		if err := Validate(raw); err == nil || !strings.Contains(err.Error(), "not message.from") {
			t.Fatalf("offline Validate should refuse an owner's signature, got %v", err)
		}
		chain := contractChain(t)
		if err := ValidateWithChain(context.Background(), raw, chain); err != nil {
			t.Fatalf("a contract wallet's authorization should be proved: %v", err)
		}
		// The call is what the token would make: the wallet, the document's digest and signature,
		// and the token as msg.sender, on the document's chain.
		if len(chain.isValidCalls) != 1 {
			t.Fatalf("want one isValidSignature call, got %d", len(chain.isValidCalls))
		}
		call := chain.isValidCalls[0]
		var doc map[string]any
		_ = json.Unmarshal(raw, &doc)
		authorization := doc["authorization"].(map[string]any)
		if call.network != baseSepolia || call.account != settlerAddress || call.caller != tokenAddress ||
			hexutilEncode(call.digest[:]) != authorization["message"] || hexutilEncode(call.signature) != authorization["signature"] {
			t.Fatalf("unexpected isValidSignature call: %+v", call)
		}
	})

	t.Run("opaque non-65-byte signature, as contract-signature.json carries", func(t *testing.T) {
		var doc map[string]any
		if err := json.Unmarshal(readConformance(t, "contract-signature.json"), &doc); err != nil {
			t.Fatal(err)
		}
		authorization := doc["authorization"].(map[string]any)
		approved := common.FromHex(authorization["signature"].(string))
		if len(approved) == 65 {
			t.Fatal("the vector is meant to carry a signature that is not 65 bytes")
		}
		// An approved-hash wallet: the signature is whatever bytes it was told to accept.
		chain := &fakeChain{hasCode: map[string]bool{settlerAddress: true}, wallet: func(_ [32]byte, signature []byte, _ string) ContractSignatureAnswer {
			if string(signature) == string(approved) {
				return ContractSignatureAnswer{ReturnData: magicReturn}
			}
			return ContractSignatureAnswer{Reverted: true}
		}}
		if err := ValidateWithChain(context.Background(), readConformance(t, "contract-signature.json"), chain); err != nil {
			t.Fatalf("a signature the wallet vouches for should pass: %v", err)
		}
	})

	t.Run("an account with no code is held to its key", func(t *testing.T) {
		chain := &fakeChain{hasCode: map[string]bool{}}
		if err := ValidateWithChain(context.Background(), readConformance(t, "settler-signed.json"), chain); err != nil {
			t.Fatalf("an EOA settler's authorization should still pass: %v", err)
		}
		if len(chain.hasCodeCalls) != 1 || len(chain.isValidCalls) != 0 {
			t.Fatalf("an account with no code should cost one code read and no call: %v %v", chain.hasCodeCalls, chain.isValidCalls)
		}
	})
}

// The permissive branch's negatives. Validate with AllowContractSignature admits each of these on
// an EOA settler's document without asking anyone; ValidateWithChain must refuse every one the
// signer's contract does not vouch for.
func TestValidateWithChainRefusesAContractSignatureTheWalletRejects(t *testing.T) {
	signatures := map[string]string{
		"one byte":  "0x11",
		"64 bytes":  "0x" + strings.Repeat("ab", 64),
		"100 bytes": "0x" + strings.Repeat("cd", 100),
	}
	for name, signature := range signatures {
		t.Run(name, func(t *testing.T) {
			raw := withSignature(t, signature)
			if err := Validate(raw, AllowContractSignature()); err != nil {
				t.Fatalf("control: the option should admit this unverified: %v", err)
			}
			// The wallet is the settler account with a different owner, so it rejects all of these.
			err := ValidateWithChain(context.Background(), raw, contractChain(t), AllowContractSignature())
			if err == nil {
				t.Fatal("accepted a signature the wallet does not vouch for")
			}
			if !errors.Is(err, ErrContractSignatureRejected) {
				t.Fatalf("want ErrContractSignatureRejected, got %v", err)
			}
			if errors.Is(err, ErrSignatureUnverifiable) {
				t.Fatalf("a refusal must not read as an unreadable chain: %v", err)
			}
		})
	}
}

func TestValidateWithChainRefusalsByWalletAnswer(t *testing.T) {
	cases := map[string]ContractSignatureAnswer{
		"revert":              {Reverted: true},
		"no return data":      {},
		"short return data":   {ReturnData: []byte{0x16, 0x26, 0xba, 0x7e}},
		"selector, unpadded":  {ReturnData: append(common.RightPadBytes([]byte{0x16, 0x26, 0xba, 0x7e}, 31), 0x01)},
		"selector, wrong end": {ReturnData: append([]byte{0x16, 0x26, 0xba, 0x7f}, make([]byte, 28)...)},
		"invalid value":       {ReturnData: common.RightPadBytes([]byte{0xff, 0xff, 0xff, 0xff}, 32)},
		"true":                {ReturnData: common.LeftPadBytes([]byte{1}, 32)},
	}
	for name, answer := range cases {
		t.Run(name, func(t *testing.T) {
			chain := &fakeChain{hasCode: map[string]bool{settlerAddress: true}, wallet: func([32]byte, []byte, string) ContractSignatureAnswer { return answer }}
			err := ValidateWithChain(context.Background(), ownerSigned(t), chain)
			if err == nil || !errors.Is(err, ErrContractSignatureRejected) || errors.Is(err, ErrSignatureUnverifiable) {
				t.Fatalf("want a contract refusal, got %v", err)
			}
		})
	}

	t.Run("the wallet trusts a caller other than the token", func(t *testing.T) {
		chain := contractChain(t)
		chain.wallet = func(digest [32]byte, signature []byte, _ string) ContractSignatureAnswer {
			return ownerWallet(t)(digest, signature, "0x0000000000000000000000000000000000000001")
		}
		if err := ValidateWithChain(context.Background(), ownerSigned(t), chain); !errors.Is(err, ErrContractSignatureRejected) {
			t.Fatalf("want a refusal, got %v", err)
		}
	})
}

func TestValidateWithChainDistinguishesAnUnreadableChain(t *testing.T) {
	boom := errors.New("rpc: connection refused")
	cases := map[string]*fakeChain{
		"code read fails": {hasCodeErr: boom},
		"the call fails":  {hasCode: map[string]bool{settlerAddress: true}, callErr: boom},
	}
	for name, chain := range cases {
		t.Run(name, func(t *testing.T) {
			err := ValidateWithChain(context.Background(), ownerSigned(t), chain)
			if !errors.Is(err, ErrSignatureUnverifiable) || errors.Is(err, ErrContractSignatureRejected) {
				t.Fatalf("want ErrSignatureUnverifiable only, got %v", err)
			}
			if !strings.Contains(err.Error(), boom.Error()) {
				t.Fatalf("the reader's error should be kept for logs: %v", err)
			}
		})
	}
}

func TestValidateWithChainNoCodeRefusals(t *testing.T) {
	t.Run("a signature that is not 65 bytes", func(t *testing.T) {
		chain := &fakeChain{hasCode: map[string]bool{}}
		err := ValidateWithChain(context.Background(), withSignature(t, "0x"+strings.Repeat("cd", 100)), chain, AllowContractSignature())
		if err == nil || !strings.Contains(err.Error(), "has no code") {
			t.Fatalf("want a refusal naming the missing code, got %v", err)
		}
		if errors.Is(err, ErrContractSignatureRejected) || errors.Is(err, ErrSignatureUnverifiable) {
			t.Fatalf("no contract was asked and the chain was read: %v", err)
		}
	})
	t.Run("another key's 65-byte signature", func(t *testing.T) {
		chain := &fakeChain{hasCode: map[string]bool{}}
		if err := ValidateWithChain(context.Background(), ownerSigned(t), chain); err == nil || !strings.Contains(err.Error(), "not message.from") {
			t.Fatalf("want a signer mismatch, got %v", err)
		}
	})
}

// The chain is read last: a document one offline rule refuses costs no read, and an account the
// quote does not name is never asked about.
func TestValidateWithChainReadsTheChainLast(t *testing.T) {
	doc := settlerSigned(t)
	typed := typedData(t, doc)
	message(typed)["value"] = "99999"
	resign(t, doc, typed)
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	chain := contractChain(t)
	if err := ValidateWithChain(context.Background(), raw, chain); err == nil || !strings.Contains(err.Error(), "does not equal fulfillment_amount") {
		t.Fatalf("want the amount rule, got %v", err)
	}
	if len(chain.hasCodeCalls) != 0 || len(chain.isValidCalls) != 0 {
		t.Fatalf("the chain was read for a document that fails offline: %v %v", chain.hasCodeCalls, chain.isValidCalls)
	}
}

func TestValidateWithChainBoundsAndSpelling(t *testing.T) {
	for name, signature := range map[string]string{
		"not hex":    "deadbeef",
		"odd length": "0x" + strings.Repeat("ab", 32) + "a",
		"too long":   "0x" + strings.Repeat("ab", 32768),
	} {
		t.Run(name, func(t *testing.T) {
			chain := contractChain(t)
			if err := ValidateWithChain(context.Background(), withSignature(t, signature), chain); err == nil {
				t.Fatal("accepted a signature that is not bounded hex")
			}
			if len(chain.hasCodeCalls) != 0 {
				t.Fatal("the chain was read for a signature that cannot be handed to it")
			}
		})
	}
}

func TestValidateWithChainNilCheckerIsValidate(t *testing.T) {
	raw := readConformance(t, "contract-signature.json")
	if err := ValidateWithChain(context.Background(), raw, nil); err == nil || !strings.Contains(err.Error(), "must be 65 bytes") {
		t.Fatalf("a nil checker should give the strict offline verdict, got %v", err)
	}
	if err := ValidateWithChain(context.Background(), raw, nil, AllowContractSignature()); err != nil {
		t.Fatalf("a nil checker with the option should give Validate's verdict, got %v", err)
	}
}

// chainVector is one case of chain-vectors.json: a fixture, what the chain says about its settler,
// and the verdict and number of chain reads both languages must reach.
type chainVector struct {
	Name    string          `json:"name"`
	File    string          `json:"file"`
	HasCode json.RawMessage `json:"has_code"`
	Wallet  *struct {
		Kind          string `json:"kind"`
		Owner         string `json:"owner"`
		TrustedCaller string `json:"trusted_caller"`
		Signature     string `json:"signature"`
		ReturnData    string `json:"return_data"`
		Message       string `json:"message"`
	} `json:"wallet"`
	Expect struct {
		Valid         bool   `json:"valid"`
		Kind          string `json:"kind"`
		ErrorContains string `json:"error_contains"`
	} `json:"expect"`
	Calls struct {
		HasCode          int `json:"has_code"`
		IsValidSignature int `json:"is_valid_signature"`
	} `json:"calls"`
}

// walletFor models the wallet a vector describes. It is a model of what an ERC-1271 wallet answers,
// never a deployed one.
func (v chainVector) walletFor(t *testing.T) func([32]byte, []byte, string) ContractSignatureAnswer {
	t.Helper()
	if v.Wallet == nil {
		return func([32]byte, []byte, string) ContractSignatureAnswer {
			t.Fatalf("%s: the wallet was called, and the vector describes none", v.Name)
			return ContractSignatureAnswer{}
		}
	}
	w := v.Wallet
	switch w.Kind {
	case "owner":
		return func(digest [32]byte, signature []byte, caller string) ContractSignatureAnswer {
			if caller != w.TrustedCaller || len(signature) != 65 {
				return ContractSignatureAnswer{Reverted: true}
			}
			sig := append([]byte(nil), signature...)
			sig[64] -= 27
			pub, err := crypto.SigToPub(digest[:], sig)
			if err != nil || strings.ToLower(crypto.PubkeyToAddress(*pub).Hex()) != w.Owner {
				return ContractSignatureAnswer{ReturnData: common.FromHex("0xffffffff00000000000000000000000000000000000000000000000000000000")}
			}
			return ContractSignatureAnswer{ReturnData: magicReturn}
		}
	case "approves":
		return func(_ [32]byte, signature []byte, _ string) ContractSignatureAnswer {
			if hexutilEncode(signature) == w.Signature {
				return ContractSignatureAnswer{ReturnData: magicReturn}
			}
			return ContractSignatureAnswer{ReturnData: common.FromHex("0xffffffff00000000000000000000000000000000000000000000000000000000")}
		}
	case "errors":
		// The call fails to run; the harness sets callErr, so this is never asked.
		return func([32]byte, []byte, string) ContractSignatureAnswer { return ContractSignatureAnswer{} }
	case "reverts":
		return func([32]byte, []byte, string) ContractSignatureAnswer { return ContractSignatureAnswer{Reverted: true} }
	case "returns":
		return func([32]byte, []byte, string) ContractSignatureAnswer {
			return ContractSignatureAnswer{ReturnData: common.FromHex(w.ReturnData)}
		}
	}
	t.Fatalf("%s: unknown wallet kind %q", v.Name, w.Kind)
	return nil
}

func TestConformanceChainVectors(t *testing.T) {
	var vectors []chainVector
	if err := json.Unmarshal(readConformance(t, "chain-vectors.json"), &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) == 0 {
		t.Fatal("no chain vectors")
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			chain := &fakeChain{hasCode: map[string]bool{}, wallet: v.walletFor(t)}
			var codeErr struct {
				Error string `json:"error"`
			}
			switch string(v.HasCode) {
			case "true":
				chain.hasCode[settlerAddress] = true
			case "false":
			default:
				if err := json.Unmarshal(v.HasCode, &codeErr); err != nil || codeErr.Error == "" {
					t.Fatalf("has_code must be a boolean or {error}: %s", v.HasCode)
				}
				chain.hasCodeErr = errors.New(codeErr.Error)
			}
			if v.Wallet != nil && v.Wallet.Kind == "errors" {
				chain.callErr = errors.New(v.Wallet.Message)
			}

			err := ValidateWithChain(context.Background(), readConformance(t, v.File), chain)
			if v.Expect.Valid {
				if err != nil {
					t.Fatalf("want valid, got %v", err)
				}
			} else {
				if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(v.Expect.ErrorContains)) {
					t.Fatalf("want an error containing %q, got %v", v.Expect.ErrorContains, err)
				}
				rejected, unverifiable := errors.Is(err, ErrContractSignatureRejected), errors.Is(err, ErrSignatureUnverifiable)
				var kind string
				switch {
				case rejected && !unverifiable:
					kind = "rejected"
				case unverifiable && !rejected:
					kind = "unverifiable"
				case !rejected && !unverifiable:
					kind = "offline"
				default:
					kind = "both"
				}
				if kind != v.Expect.Kind {
					t.Fatalf("want a %s refusal, got a %s one: %v", v.Expect.Kind, kind, err)
				}
			}
			if len(chain.hasCodeCalls) != v.Calls.HasCode || len(chain.isValidCalls) != v.Calls.IsValidSignature {
				t.Fatalf("want %d code reads and %d calls, got %d and %d", v.Calls.HasCode, v.Calls.IsValidSignature, len(chain.hasCodeCalls), len(chain.isValidCalls))
			}
		})
	}
}

// Both errors from a reader are refusals. Nothing a reader can fail with passes, and a failure the
// settler can steer a wallet into (out of gas, an invalid opcode) is one of them, so a caller that
// gates on the pass is shut by it.
func TestValidateWithChainNeverPassesAnUnverifiableDocument(t *testing.T) {
	boom := errors.New("evm: invalid opcode: opcode 0xfe not defined")
	cases := map[string]*fakeChain{
		"code read fails":                       {hasCodeErr: boom},
		"the call fails (invalid opcode)":       {hasCode: map[string]bool{settlerAddress: true}, callErr: boom},
		"the reader does not serve the network": {servedNetwork: "eip155:1", hasCode: map[string]bool{settlerAddress: true}},
	}
	for name, chain := range cases {
		t.Run(name, func(t *testing.T) {
			// Both documents a pass would gate: a contract wallet's and an EOA's.
			for _, file := range []string{"signature-not-from.json", "settler-signed.json"} {
				err := ValidateWithChain(context.Background(), readConformance(t, file), chain)
				if err == nil {
					t.Fatalf("%s: an unreadable chain passed", file)
				}
				if !errors.Is(err, ErrSignatureUnverifiable) || errors.Is(err, ErrContractSignatureRejected) {
					t.Fatalf("%s: want ErrSignatureUnverifiable only, got %v", file, err)
				}
			}
		})
	}
}

// The reader is asked about the document's network, so one that serves only another chain fails
// rather than answer from it.
func TestValidateWithChainAsksTheDocumentsNetwork(t *testing.T) {
	chain := contractChain(t)
	chain.servedNetwork = baseSepolia
	if err := ValidateWithChain(context.Background(), ownerSigned(t), chain); err != nil {
		t.Fatalf("a reader that serves the document's network should answer: %v", err)
	}
	for _, network := range append(chain.hasCodeCalls, "") {
		if network != "" && !strings.HasPrefix(network, baseSepolia+"/") {
			t.Fatalf("asked about %s, not the document's chain", network)
		}
	}
}

func TestValidateWithChainBlock(t *testing.T) {
	t.Run("default is the latest block for both reads", func(t *testing.T) {
		chain := contractChain(t)
		if err := ValidateWithChain(context.Background(), ownerSigned(t), chain); err != nil {
			t.Fatal(err)
		}
		if len(chain.hasCodeBlocks) != 1 || chain.hasCodeBlocks[0] != nil || len(chain.isValidCalls) != 1 || chain.isValidCalls[0].block != nil {
			t.Fatalf("want nil blocks, got %v %v", chain.hasCodeBlocks, chain.isValidCalls)
		}
	})
	t.Run("AtBlock puts both reads at one block", func(t *testing.T) {
		chain := contractChain(t)
		block := big.NewInt(12345)
		if err := ValidateWithChain(context.Background(), ownerSigned(t), chain, AtBlock(block)); err != nil {
			t.Fatal(err)
		}
		block.SetInt64(1) // the option copied it
		if len(chain.hasCodeBlocks) != 1 || chain.hasCodeBlocks[0].Int64() != 12345 || len(chain.isValidCalls) != 1 || chain.isValidCalls[0].block.Int64() != 12345 {
			t.Fatalf("want block 12345 on both reads, got %v %v", chain.hasCodeBlocks, chain.isValidCalls)
		}
	})
	t.Run("AtBlock(nil) is the latest", func(t *testing.T) {
		chain := contractChain(t)
		if err := ValidateWithChain(context.Background(), ownerSigned(t), chain, AtBlock(big.NewInt(7)), AtBlock(nil)); err != nil {
			t.Fatal(err)
		}
		if chain.hasCodeBlocks[0] != nil || chain.isValidCalls[0].block != nil {
			t.Fatal("AtBlock(nil) should read at the latest")
		}
	})
}
