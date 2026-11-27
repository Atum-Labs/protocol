package ldverification

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/mr-tron/base58"
)

// The key and strkeys are the shared strkey vectors' account and contract entries (see below).
const (
	stellarPubkeyHex = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29"
	stellarAccountG  = "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH"
	stellarContractC = "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5"
)

func TestStellarStrkeyMatchesSharedVector(t *testing.T) {
	key, err := hex.DecodeString(stellarPubkeyHex)
	if err != nil {
		t.Fatal(err)
	}
	if got := encodeStellarAccount(key); got != stellarAccountG {
		t.Fatalf("encode = %s, want %s", got, stellarAccountG)
	}
	decoded, err := decodeStellarAccount(stellarAccountG)
	if err != nil || hex.EncodeToString(decoded) != stellarPubkeyHex {
		t.Fatalf("decode = %x, %v", decoded, err)
	}
}

// strkeyVectorsPath is the one strkey vector file every Stellar strkey decoder in the repo is tested
// against. This package no longer carries its own decoder; the test proves that calling the shared
// one keeps every case's outcome, with the signer's extra rule that only a G account can sign.
const strkeyVectorsPath = "../../../../../../../contracts/stellar/conformance/strkey-vectors.json"

type strkeyVectors struct {
	Valid []struct {
		Name       string `json:"name"`
		Address    string `json:"address"`
		Kind       string `json:"kind"`
		PayloadHex string `json:"payloadHex"`
	} `json:"valid"`
	Invalid []struct {
		Name    string `json:"name"`
		Address string `json:"address"`
	} `json:"invalid"`
}

func loadStrkeyVectors(t *testing.T) strkeyVectors {
	t.Helper()
	raw, err := os.ReadFile(strkeyVectorsPath)
	if err != nil {
		t.Fatalf("read strkey vectors: %v", err)
	}
	var v strkeyVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse strkey vectors: %v", err)
	}
	if len(v.Valid) == 0 || len(v.Invalid) == 0 {
		t.Fatal("strkey vector tables are empty, so this test proves nothing")
	}
	return v
}

func TestStellarStrkeySharedVectors(t *testing.T) {
	v := loadStrkeyVectors(t)
	for _, c := range v.Valid {
		t.Run("valid/"+c.Name, func(t *testing.T) {
			key, err := decodeStellarAccount(c.Address)
			if c.Kind == "contract" {
				// A C contract cannot sign, so the signer refuses what the decoder accepts.
				if err == nil || !strings.Contains(err.Error(), "G account") {
					t.Fatalf("err = %v, want a refusal naming the G account", err)
				}
				return
			}
			if err != nil || hex.EncodeToString(key) != c.PayloadHex {
				t.Fatalf("decode = %x, %v, want %s", key, err, c.PayloadHex)
			}
			if got := encodeStellarAccount(key); got != c.Address {
				t.Errorf("encode = %s, want %s", got, c.Address)
			}
		})
	}
	for _, c := range v.Invalid {
		t.Run("invalid/"+c.Name, func(t *testing.T) {
			if key, err := decodeStellarAccount(c.Address); err == nil {
				t.Fatalf("accepted %q as %x", c.Address, key)
			}
		})
	}
}

func TestStellarStrkeyRefusalCauses(t *testing.T) {
	cases := []struct{ name, strkey, want string }{
		{"contract", stellarContractC, "G account"},
		{"checksum", stellarAccountG[:55] + "G", "checksum"},
		{"lowercase", strings.ToLower(stellarAccountG), "upper-case"},
		{"short", stellarAccountG[:55], "invalid strkey"},
		{"S-prefixed string, valid checksum", "SA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCTOLY", "not an account"},
		{"newline in a 31-byte payload", "GA5WUJ54Z23KILLCUOUN\nAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ", "upper-case"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := decodeStellarAccount(tc.strkey)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to contain %q", err, tc.want)
			}
		})
	}
}

// A quote signed by a Stellar settler: the ed25519 proof resolves the public key out of a
// did:pkh:stellar verificationMethod, and surfaces the network for the caller's CAIP-2 binding.
func TestRoundTrip_Ed25519_Stellar(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	account := encodeStellarAccount(pub)
	created := time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC)

	for _, method := range []string{
		"did:pkh:stellar:pubnet:" + account + "#blockchainAccountId",
		"did:pkh:stellar:testnet:" + account,
		"DID:PKH:STELLAR:testnet:" + account + "#blockchainAccountId",
	} {
		t.Run(method[:24], func(t *testing.T) {
			res, err := Verify(signEd25519WithMethodForTest(t, priv, base58.Encode(pub), method, created))
			if err != nil {
				t.Fatalf("verify: %v", err)
			}
			signer := mustEd25519Signer(t, res)
			if !signer.PublicKey.Equal(pub) {
				t.Errorf("public key mismatch")
			}
			if signer.DIDNamespace != "stellar" {
				t.Errorf("DIDNamespace = %q, want %q", signer.DIDNamespace, "stellar")
			}
			wantNetwork := strings.Split(method, ":")[3]
			if signer.DIDNetwork != wantNetwork {
				t.Errorf("DIDNetwork = %q, want %q", signer.DIDNetwork, wantNetwork)
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
		{"empty network", "did:pkh:stellar::" + account, "empty network segment"},
		{"empty address", "did:pkh:stellar:pubnet:", "empty address segment"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Verify(signEd25519WithMethodForTest(t, priv, base58.Encode(pub), tc.method, created))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to contain %q", err, tc.want)
			}
			if !errors.Is(err, ErrMalformedQuote) {
				t.Errorf("err = %v, want it to wrap ErrMalformedQuote", err)
			}
		})
	}
}

// The VP holder binding: the key resolved from the proof has to be the holder's own account, in the
// namespace the holder names.
func TestSignerMatchesHolderEd25519_Stellar(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	if err := signerMatchesHolderEd25519(pub, "did:pkh:stellar:pubnet:"+encodeStellarAccount(pub)); err != nil {
		t.Errorf("own account refused: %v", err)
	}
	if err := signerMatchesHolderEd25519(pub, "did:pkh:solana:devnet:"+base58.Encode(pub)); err != nil {
		t.Errorf("solana holder regressed: %v", err)
	}
	if err := signerMatchesHolderEd25519(pub, "did:pkh:stellar:pubnet:"+encodeStellarAccount(other)); !errors.Is(err, ErrVPSignerHolderMismatch) {
		t.Errorf("another account: err = %v, want ErrVPSignerHolderMismatch", err)
	}
	// A contract strkey is never a signer, even if someone writes it as the holder.
	if err := signerMatchesHolderEd25519(pub, "did:pkh:stellar:pubnet:"+stellarContractC); !errors.Is(err, ErrVPSignerHolderMismatch) {
		t.Errorf("contract holder: err = %v, want ErrVPSignerHolderMismatch", err)
	}
	if err := signerMatchesHolderEd25519(pub, "did:pkh:aptos:mainnet:"+base58.Encode(pub)); !errors.Is(err, ErrUnsupportedProofType) {
		t.Errorf("other namespace: err = %v, want ErrUnsupportedProofType", err)
	}
}

// A verificationMethod whose strkey decodes to a short key must be refused as malformed, never
// reach ed25519.Verify, which panics on a key that is not 32 bytes.
func TestVerify_Ed25519_StellarShortKeyDoesNotPanic(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	created := time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC)
	for _, address := range []string{
		"GA5WUJ54Z23KILLCUOUN\nAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ",
		"GA5WUJ54Z23KILLCUOUN\rAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ",
		"GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ\n",
		"\nGA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ",
	} {
		method := "did:pkh:stellar:pubnet:" + address + "#blockchainAccountId"
		t.Run(strings.NewReplacer("\n", "LF", "\r", "CR").Replace(address[:8]+address[len(address)-4:]), func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("Verify panicked: %v", r)
				}
			}()
			_, err := Verify(signEd25519WithMethodForTest(t, priv, base58.Encode(pub), method, created))
			if err == nil || !errors.Is(err, ErrMalformedQuote) {
				t.Fatalf("err = %v, want ErrMalformedQuote", err)
			}
		})
	}
}

// The namespace travels with the network reference. "devnet" and "testnet" are not
// unique to one namespace, so a quote signed as did:pkh:stellar:devnet:G... must not
// satisfy a Solana devnet check, and a did:pkh:solana:devnet:<base58> quote must not
// satisfy a Stellar one, even though the reference and the key are the same.
func TestSignerMatchesChain_NamespaceAndNetwork(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	created := time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC)
	stellarDID := "did:pkh:stellar:devnet:" + encodeStellarAccount(pub)
	solanaDID := "did:pkh:solana:devnet:" + base58.Encode(pub)

	signerFor := func(t *testing.T, method string) SelfAssertedEd25519Signer {
		t.Helper()
		res, err := Verify(signEd25519WithMethodForTest(t, priv, base58.Encode(pub), method, created))
		if err != nil {
			t.Fatalf("verify %s: %v", method, err)
		}
		return mustEd25519Signer(t, res)
	}

	cases := []struct {
		name, method, chain string
		wantErr             bool
	}{
		{"solana DID, solana chain", solanaDID, "solana:devnet", false},
		{"stellar DID, stellar chain", stellarDID, "stellar:devnet", false},
		{"stellar DID with a solana reference is refused", stellarDID, "solana:devnet", true},
		{"solana DID with a stellar reference is refused", solanaDID, "stellar:devnet", true},
		{"right namespace, wrong reference", stellarDID, "stellar:pubnet", true},
		{"case-insensitive on both parts", "DID:PKH:STELLAR:DevNet:" + encodeStellarAccount(pub), "Stellar:devnet", false},
		{"not a CAIP-2 identifier", stellarDID, "devnet", true},
		{"empty reference", stellarDID, "stellar:", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := signerFor(t, tc.method).MatchesChain(tc.chain)
			if tc.wantErr {
				if !errors.Is(err, ErrSignerChainMismatch) {
					t.Fatalf("err = %v, want ErrSignerChainMismatch", err)
				}
				if errors.Is(err, ErrMalformedProof) {
					t.Errorf("a chain mismatch is an authorization refusal, not a malformed proof: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("err = %v, want nil", err)
			}
		})
	}
}
