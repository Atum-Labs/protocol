package ldverification

import (
	"crypto/ecdsa"
	"encoding/json"
	"strings"
	"testing"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// The typed form of the inner PaymentRequest proof: the wallet-signable twin of the raw form,
// over the same two hashes. These pin that it verifies, that it binds exactly what the raw form
// binds, and that the raw form is untouched.

const typedCreated = "2026-04-01T00:00:00.000Z"

func typedTestDoc(address string) map[string]any {
	return map[string]any{
		"version":    "1.0",
		"request_id": "req-pr-typed-1",
		"source": map[string]any{
			"asset_identifier": "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A",
			"account":          address,
		},
		"destination": []any{map[string]any{
			"asset_identifier": "eip155:1/erc20:0xbbb",
			"account":          "0x0000000000000000000000000000000000000002",
		}},
		"fulfillment_amount":      "1000000",
		"quote_deadline":          "2030-01-01T00:00:00Z",
		"fulfillment_deadline":    "2030-01-02T00:00:00Z",
		"escrow_contract_address": "0x0000000000000000000000000000000000000003",
		"fulfillment_verifier":    map[string]any{"account": "0x0000000000000000000000000000000000000004", "endpoint": "https://veri-fill.example.com"},
		"sender_auth": map[string]any{
			"message_scheme": "EVM_PERMIT2",
			"signed_messages": []any{map[string]any{
				"message": "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f", "message_prehash": "{}", "signature": "0xabcdef1234567890",
			}},
		},
	}
}

func typedTestKey(t *testing.T) (*ecdsa.PrivateKey, string) {
	t.Helper()
	priv, err := crypto.HexToECDSA("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	if err != nil {
		t.Fatal(err)
	}
	return priv, strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
}

func signTyped(t *testing.T, priv *ecdsa.PrivateKey, doc map[string]any, method string) []byte {
	t.Helper()
	signer, err := lddataintegrity.NewECDSASigner(priv)
	if err != nil {
		t.Fatal(err)
	}
	signed, err := SignPaymentRequestTypedWithSignerAndCreatedString(doc, signer, SignOptions{
		VerificationMethod: method,
		ProofPurpose:       "assertionMethod",
	}, typedCreated)
	if err != nil {
		t.Fatalf("SignPaymentRequestTypedWithSignerAndCreatedString: %v", err)
	}
	return signed
}

// acceptTyped is a verifier of an originator's own payment request, which accepts the typed form.
var acceptTyped = VerifyOptions{AcceptPaymentRequestTypedProof: true}

func recovered(t *testing.T, signed []byte) common.Address {
	t.Helper()
	res, err := VerifyPaymentRequestWithOptions(signed, acceptTyped)
	if err != nil {
		t.Fatalf("VerifyPaymentRequest: %v", err)
	}
	return mustSecp256k1Signer(t, res)
}

func TestTypedProof_VerifiesAndRecoversTheSigner(t *testing.T) {
	priv, address := typedTestKey(t)
	signed := signTyped(t, priv, typedTestDoc(address), "did:pkh:eip155:1:"+address+"#blockchainAccountId")
	if got := recovered(t, signed); !strings.EqualFold(got.Hex(), address) {
		t.Fatalf("recovered %s, want %s", got.Hex(), address)
	}
	identity, err := RecoverSignerIdentityWithOptions(signed, "eip155:1", acceptTyped)
	if err != nil || identity != address {
		t.Fatalf("RecoverSignerIdentityWithOptions = %q, %v; want %q", identity, err, address)
	}
}

// A verifier that does not ask for the typed form does not take it: the typed signature recovers
// someone other than its signer, as any signature over another digest does, and with no error, so
// the caller's signer check is what refuses it. VerifyPaymentRequest and RecoverSignerIdentity,
// which the published SDKs and every other caller use, are such verifiers.
func TestTypedProof_RecoversAnotherSignerWithoutTheOptIn(t *testing.T) {
	priv, address := typedTestKey(t)
	signed := signTyped(t, priv, typedTestDoc(address), "did:pkh:eip155:1:"+address+"#blockchainAccountId")
	res, err := VerifyPaymentRequest(signed)
	if err != nil {
		t.Fatal(err)
	}
	if got := mustSecp256k1Signer(t, res); strings.EqualFold(got.Hex(), address) {
		t.Fatal("VerifyPaymentRequest recovered the signer of a typed proof without the opt-in")
	}
	identity, err := RecoverSignerIdentity(signed, "eip155:1")
	if err != nil {
		t.Fatal(err)
	}
	if identity == address {
		t.Fatal("RecoverSignerIdentity recovered the signer of a typed proof without the opt-in")
	}
}

// The typed proof is the raw proof with only the signature changed: same proof options, same wire
// shape, and a signature over PaymentRequestProof{proofHash, docHash} of the very hashes whose
// keccak256(proofHash || docHash) the raw form signs.
func TestTypedProof_SignsTheRawFormsHashes(t *testing.T) {
	priv, address := typedTestKey(t)
	method := "did:pkh:eip155:1:" + address + "#blockchainAccountId"
	typed := signTyped(t, priv, typedTestDoc(address), method)
	raw, err := SignPaymentRequestWithCreatedString(typedTestDoc(address), priv, SignOptions{VerificationMethod: method, ProofPurpose: "assertionMethod"}, typedCreated)
	if err != nil {
		t.Fatal(err)
	}
	var typedDoc, rawDoc map[string]any
	if err := json.Unmarshal(typed, &typedDoc); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &rawDoc); err != nil {
		t.Fatal(err)
	}
	typedJWS := typedDoc["proof"].(map[string]any)["jws"].(string)
	rawJWS := rawDoc["proof"].(map[string]any)["jws"].(string)
	if typedJWS == rawJWS {
		t.Fatal("the typed and raw forms carry the same signature")
	}
	delete(typedDoc["proof"].(map[string]any), "jws")
	delete(rawDoc["proof"].(map[string]any), "jws")
	a, _ := json.Marshal(typedDoc)
	b, _ := json.Marshal(rawDoc)
	if string(a) != string(b) {
		t.Fatalf("the typed form differs from the raw form beyond its signature:\n typed %s\n raw   %s", a, b)
	}

	var req struct {
		Proof struct{ Jws string } `json:"proof"`
	}
	if err := json.Unmarshal(typed, &req); err != nil {
		t.Fatal(err)
	}
	_, sig, err := ParseDetachedJWS(req.Proof.Jws)
	if err != nil {
		t.Fatal(err)
	}
	doc, rawProof, err := documentForCanonicalization(typed)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := HashPaymentRequest(doc, HashPaymentRequestOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020,
		ProofOptions: HashableProofOptions{
			Type: ProofTypeSecp256k1Recovery2020, Created: rawString(rawProof, "created"),
			VerificationMethod: method, ProofPurpose: "assertionMethod", Context: rawProof["@context"],
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := crypto.Keccak256(hash.ProofHash, hash.DocHash); string(got) != string(hash.SigningInput) {
		t.Fatal("the raw signing input is not keccak256(proofHash || docHash)")
	}
	digest, err := lddataintegrity.PaymentRequestProofTypedDigest(hash.ProofHash, hash.DocHash)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := RecoverAddress(digest, sig)
	if err != nil || !strings.EqualFold(signer.Hex(), address) {
		t.Fatalf("the typed signature recovers %s (%v) from PaymentRequestProof{proofHash, docHash}, want %s", signer.Hex(), err, address)
	}
}

// Everything the raw form binds, the typed form binds: changing any of it after signing recovers
// a signer other than the one who signed.
func TestTypedProof_BindsWhatTheRawFormBinds(t *testing.T) {
	priv, address := typedTestKey(t)
	method := "did:pkh:eip155:1:" + address + "#blockchainAccountId"
	signed := signTyped(t, priv, typedTestDoc(address), method)
	for _, tc := range []struct {
		name   string
		mutate func(m map[string]any)
	}{
		{"request_id", func(m map[string]any) { m["request_id"] = "req-pr-typed-2" }},
		{"fulfillment_amount", func(m map[string]any) { m["fulfillment_amount"] = "1000001" }},
		{"source.account", func(m map[string]any) {
			m["source"].(map[string]any)["account"] = "0x0000000000000000000000000000000000000009"
		}},
		{"destination account", func(m map[string]any) {
			m["destination"].([]any)[0].(map[string]any)["account"] = "0x0000000000000000000000000000000000000008"
		}},
		{"sender_auth signature", func(m map[string]any) {
			m["sender_auth"].(map[string]any)["signed_messages"].([]any)[0].(map[string]any)["signature"] = "0xabcdef1234567891"
		}},
		{"quote_deadline", func(m map[string]any) { m["quote_deadline"] = "2030-01-01T00:00:01Z" }},
		{"proof.created", func(m map[string]any) { m["proof"].(map[string]any)["created"] = "2026-04-01T00:00:01.000Z" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var m map[string]any
			if err := json.Unmarshal(signed, &m); err != nil {
				t.Fatal(err)
			}
			tc.mutate(m)
			mutated, _ := json.Marshal(m)
			res, err := VerifyPaymentRequestWithOptions(mutated, acceptTyped)
			if err != nil {
				return // refused outright: bound
			}
			if got := mustSecp256k1Signer(t, res); strings.EqualFold(got.Hex(), address) {
				t.Fatalf("changing %s after a typed signature still recovers the signer", tc.name)
			}
		})
	}
}

// The typed form is taken only for the signer the proof names. A typed signature under a
// verificationMethod naming someone else recovers that someone else from neither form.
func TestTypedProof_OnlyForTheNamedSigner(t *testing.T) {
	priv, address := typedTestKey(t)
	other := "0x0000000000000000000000000000000000000007"
	signed := signTyped(t, priv, typedTestDoc(address), "did:pkh:eip155:1:"+other+"#blockchainAccountId")
	got := recovered(t, signed)
	if strings.EqualFold(got.Hex(), address) || strings.EqualFold(got.Hex(), other) {
		t.Fatalf("a typed signature under a verificationMethod naming %s recovered %s", other, got.Hex())
	}
}

// A signature over another typed struct of the same hashes, the envelope's or the settler's, is
// not a PaymentRequestProof.
func TestTypedProof_RefusesOtherTypedStructs(t *testing.T) {
	priv, address := typedTestKey(t)
	for _, tc := range []struct {
		name     string
		digestOf lddataintegrity.TypedProofDigest
	}{
		{"PaymentRequestEnvelopeProof", lddataintegrity.PaymentRequestEnvelopeProofTypedDigest},
		{"SettlerProof", lddataintegrity.SettlerProofTypedDigest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			signer, err := lddataintegrity.NewECDSASigner(priv)
			if err != nil {
				t.Fatal(err)
			}
			signed, err := signPaymentRequest(typedTestDoc(address), signer, SignOptions{
				VerificationMethod: "did:pkh:eip155:1:" + address + "#blockchainAccountId",
				ProofPurpose:       "assertionMethod",
			}, typedCreated, func(h HashResult) ([]byte, error) { return tc.digestOf(h.ProofHash, h.DocHash) })
			if err != nil {
				t.Fatal(err)
			}
			if got := recovered(t, signed); strings.EqualFold(got.Hex(), address) {
				t.Fatalf("a %s signature verified as the inner PaymentRequest proof", tc.name)
			}
		})
	}
}

// A tron verificationMethod names its signer by base58check, and the typed form is matched to it.
func TestTypedProof_TronVerificationMethod(t *testing.T) {
	priv, address := typedTestKey(t)
	tron := evmHashToTronBase58(common.HexToAddress(address))
	doc := typedTestDoc(address)
	doc["source"] = map[string]any{"asset_identifier": "tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "account": tron}
	signed := signTyped(t, priv, doc, "did:pkh:tron:mainnet:"+tron+"#blockchainAccountId")
	identity, err := RecoverSignerIdentityWithOptions(signed, "tron:mainnet", acceptTyped)
	if err != nil || identity != tron {
		t.Fatalf("RecoverSignerIdentity = %q, %v; want %q", identity, err, tron)
	}
}
