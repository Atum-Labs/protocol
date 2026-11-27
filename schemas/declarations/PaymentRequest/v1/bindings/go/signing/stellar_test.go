package ldverification

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/mr-tron/base58"
)

// signRequestEd25519WithMethodForTest signs the same minimal request as
// signRequestEd25519ForTest under an arbitrary verificationMethod.
func signRequestEd25519WithMethodForTest(t *testing.T, priv ed25519.PrivateKey, source, method string, created time.Time) []byte {
	t.Helper()
	doc := map[string]any{
		"version":    "1.0",
		"request_id": "req-pr-stellar-1",
		"source": map[string]any{
			"asset_identifier": source,
			"account":          "ignored-by-the-verifier",
		},
		"destination": []any{
			map[string]any{"asset_identifier": "eip155:1/erc20:0xbbb", "account": "0x2"},
		},
		"fulfillment_amount":      "1000000",
		"quote_deadline":          "2030-01-01T00:00:00Z",
		"fulfillment_deadline":    "2030-01-02T00:00:00Z",
		"escrow_contract_address": "0x0000000000000000000000000000000000000003",
		"fulfillment_verifier":    map[string]any{"account": "0x0000000000000000000000000000000000000004", "endpoint": "https://veri-fill.example.com"},
	}
	signed, err := SignPaymentRequestEd25519(doc, priv, SignEd25519Options{
		VerificationMethod: method,
		ProofPurpose:       "assertionMethod",
		Created:            created,
	})
	if err != nil {
		t.Fatalf("sign_ed25519: %v", err)
	}
	return signed
}

const (
	stellarSource = "stellar:pubnet/sep41:CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5"
	solanaSource  = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/spltoken:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
)

// A Stellar originator signs as the schema describes: the ed25519 proof resolves the public key out
// of a did:pkh:stellar verificationMethod and surfaces namespace and network.
func TestRoundTrip_Ed25519_Stellar(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	account := encodeStellarAccount(pub)
	created := time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC)

	for _, tc := range []struct{ method, wantNetwork string }{
		{"did:pkh:stellar:pubnet:" + account + "#blockchainAccountId", "pubnet"},
		{"did:pkh:stellar:testnet:" + account, "testnet"},
		{"DID:PKH:STELLAR:testnet:" + account + "#blockchainAccountId", "testnet"},
	} {
		t.Run(tc.method[:24], func(t *testing.T) {
			res, err := VerifyPaymentRequest(signRequestEd25519WithMethodForTest(t, priv, stellarSource, tc.method, created))
			if err != nil {
				t.Fatalf("verify: %v", err)
			}
			signer := mustEd25519Signer(t, res)
			if !signer.PublicKey.Equal(pub) {
				t.Errorf("public key mismatch")
			}
			if signer.DIDNamespace != "stellar" || signer.DIDNetwork != tc.wantNetwork {
				t.Errorf("namespace/network = %q/%q, want stellar/%q", signer.DIDNamespace, signer.DIDNetwork, tc.wantNetwork)
			}
		})
	}
}

func TestVerify_Ed25519_StellarVerificationMethodErrors(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	account := encodeStellarAccount(pub)
	created := time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC)

	cases := []struct{ name, method, want string }{
		{"contract strkey", "did:pkh:stellar:pubnet:" + stellarContractC, "G account"},
		{"bad checksum", "did:pkh:stellar:pubnet:" + stellarAccountG[:55] + "G", "checksum"},
		{"lowercase", "did:pkh:stellar:pubnet:" + strings.ToLower(account), "upper-case"},
		{"base58 string under stellar", "did:pkh:stellar:pubnet:" + base58.Encode(pub), "upper-case"},
		// A fixed G strkey: one from a random key lacks O and I about 3% of the time and then decodes as base58.
		{"strkey under solana", "did:pkh:solana:devnet:" + stellarAccountG, "base58"},
		{"empty network", "did:pkh:stellar::" + account, "empty network segment"},
		{"empty address", "did:pkh:stellar:pubnet:", "empty address segment"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := VerifyPaymentRequest(signRequestEd25519WithMethodForTest(t, priv, stellarSource, tc.method, created))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to contain %q", err, tc.want)
			}
			if !errors.Is(err, ErrMalformedRequest) {
				t.Errorf("err = %v, want it to wrap ErrMalformedRequest", err)
			}
		})
	}
}

// RecoverSignerIdentity binds the namespace as well as the network: a request whose source is a
// Solana asset cannot be satisfied by a Stellar DID with the same reference and key, nor the reverse.
func TestRecoverSignerIdentity_NamespaceBinding(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	created := time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC)
	stellarDID := "did:pkh:stellar:devnet:" + encodeStellarAccount(pub)
	solanaDID := "did:pkh:solana:devnet:" + base58.Encode(pub)

	cases := []struct {
		name, method, chain, want string
		wantErr                   bool
	}{
		{"stellar DID, stellar chain", stellarDID, "stellar:devnet", encodeStellarAccount(pub), false},
		{"solana DID, solana chain", solanaDID, "solana:devnet", base58.Encode(pub), false},
		{"stellar DID with a solana reference is refused", stellarDID, "solana:devnet", "", true},
		{"solana DID with a stellar reference is refused", solanaDID, "stellar:devnet", "", true},
		{"stellar DID, wrong stellar network", stellarDID, "stellar:pubnet", "", true},
		{"chain casing", stellarDID, "STELLAR:Devnet", encodeStellarAccount(pub), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			signed := signRequestEd25519WithMethodForTest(t, priv, stellarSource, tc.method, created)
			got, err := RecoverSignerIdentity(signed, tc.chain)
			if tc.wantErr {
				if !errors.Is(err, ErrSignerChainMismatch) {
					t.Fatalf("err = %v, want ErrSignerChainMismatch", err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}

	// An ed25519 proof cannot satisfy an EVM source, and Stellar is a recognised chain.
	signed := signRequestEd25519WithMethodForTest(t, priv, stellarSource, stellarDID, created)
	if _, err := RecoverSignerIdentity(signed, "eip155:1"); err == nil {
		t.Error("ed25519 proof accepted for an EVM source")
	}
	if _, err := RecoverSignerIdentity(signed, "aptos:1"); err == nil || !strings.Contains(err.Error(), "unsupported source chain") {
		t.Errorf("err = %v, want unsupported source chain", err)
	}
}

func TestSignerMatchesChain_MalformedChain(t *testing.T) {
	s := SelfAssertedEd25519Signer{DIDNamespace: "stellar", DIDNetwork: "devnet"}
	for _, chain := range []string{"devnet", "stellar:", ":devnet", ""} {
		if err := s.MatchesChain(chain); !errors.Is(err, ErrSignerChainMismatch) {
			t.Errorf("MatchesChain(%q) = %v, want ErrSignerChainMismatch", chain, err)
		}
	}
}

// The shared strkey vectors' account and contract entries.
const (
	stellarPubkeyHex = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29"
	stellarAccountG  = "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH"
	stellarContractC = "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5"
)

// The cross-language Stellar fixtures: one request signed under the zero seed by each signer
// (byte-identical, as for the Solana pair), whose key is the shared strkey vectors' account.
func TestConformance_StellarFixtures(t *testing.T) {
	goSigned := readFixture(t, "ed25519-stellar-go-signed.json")
	tsSigned := readFixture(t, "ed25519-stellar-ts-signed.json")
	if string(goSigned) != string(tsSigned) {
		t.Fatal("Go-signed and TS-signed Stellar fixtures differ")
	}

	res, err := VerifyPaymentRequest(tsSigned)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	signer := mustEd25519Signer(t, res)
	if got := hex.EncodeToString(signer.PublicKey); got != stellarPubkeyHex {
		t.Errorf("public key = %s, want %s", got, stellarPubkeyHex)
	}
	if encodeStellarAccount(signer.PublicKey) != stellarAccountG {
		t.Errorf("account = %s, want %s", encodeStellarAccount(signer.PublicKey), stellarAccountG)
	}
	if signer.DIDNamespace != "stellar" || signer.DIDNetwork != "testnet" {
		t.Errorf("namespace/network = %q/%q, want stellar/testnet", signer.DIDNamespace, signer.DIDNetwork)
	}

	// The same key and reference under the other namespace must not satisfy the chain check, and the
	// Solana fixture (devnet) must not satisfy a Stellar one.
	if got, err := RecoverSignerIdentity(tsSigned, "stellar:testnet"); err != nil || got != stellarAccountG {
		t.Errorf("stellar source: got %q, %v; want %s", got, err, stellarAccountG)
	}
	if _, err := RecoverSignerIdentity(tsSigned, "solana:testnet"); !errors.Is(err, ErrSignerChainMismatch) {
		t.Errorf("stellar DID against a solana source: err = %v, want ErrSignerChainMismatch", err)
	}
	if _, err := RecoverSignerIdentity(readFixture(t, "ed25519-go-signed.json"), "stellar:devnet"); !errors.Is(err, ErrSignerChainMismatch) {
		t.Errorf("solana DID against a stellar source: err = %v, want ErrSignerChainMismatch", err)
	}
}
