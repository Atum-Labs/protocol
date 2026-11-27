package ldverification

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/mr-tron/base58"
)

// signFixtureDoc is the same shape the test helpers build. Kept inline
// here so the public-API tests don't reach across test files for the
// shared map literal. The settler_address field gets filled per-test
// once the address has been derived from the keypair.
func signFixtureDoc(settlerAddress string) map[string]any {
	return map[string]any{
		"version":              "1.0",
		"source_amount":        "1000000",
		"award_deadline":       "2030-01-01T00:00:00Z",
		"source":               map[string]any{"id": "eip155:1/erc20:0xaaa", "account": "eip155:1:0x1"},
		"destination":          map[string]any{"id": "eip155:1/erc20:0xbbb", "account": "eip155:1:0x2"},
		"settler_address":      settlerAddress,
		"payment_request_json": `{"request_id":"req-1"}`,
	}
}

// TestSign_RoundTripsThroughVerify is the load-bearing invariant of the
// public Sign API: a freshly-generated key signs a fixture, Verify
// recovers the same address, and Result.Signer is a
// RecoveredSecp256k1Signer. Any regression in the canonical-context
// injection, JWS encoding, or v-byte alignment fires here.
func TestSign_RoundTripsThroughVerify(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())

	signed, err := Sign(signFixtureDoc(address), priv, SignOptions{
		VerificationMethod: "did:pkh:eip155:1:" + address + "#blockchainAccountId",
		ProofPurpose:       expectedProofPurpose,
		Created:            time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	res, err := Verify(signed)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	signerAddr := mustSecp256k1Signer(t, res)
	expected := crypto.PubkeyToAddress(priv.PublicKey)
	if signerAddr != expected {
		t.Errorf("SignerAddress = %s, want %s", signerAddr.Hex(), expected.Hex())
	}
}

// TestVerify_RecoversFullPrecisionCreated pins that Verify round-trips
// proof.created at full precision (hour/min/sec/millis) — the midnight
// conformance fixtures can't exercise that. Kept local so the shared fixtures
// (a cross-service contract consumed by verifiers) stay untouched; combined
// with the verbatim created bytes the quote_hash golden pins, this gives
// cross-language created parity at sub-second resolution.
func TestVerify_RecoversFullPrecisionCreated(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())

	// Non-zero in every component so a truncating parse can't pass.
	const created = "2026-04-01T13:37:42.123Z"
	signed, err := SignWithCreatedString(signFixtureDoc(address), priv, SignOptions{
		VerificationMethod: "did:pkh:eip155:1:" + address + "#blockchainAccountId",
		ProofPurpose:       expectedProofPurpose,
	}, created)
	if err != nil {
		t.Fatalf("SignWithCreatedString: %v", err)
	}

	res, err := Verify(signed)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got := res.Created.UTC().Format(createdLayout); got != created {
		t.Fatalf("recovered Created = %s, want %s", got, created)
	}
}

// TestSign_StripsPreExistingProofAndContext pins the strip-and-rebuild
// invariant: a doc passed in with a stale proof and @context MUST be
// signed identically to one without them, because Sign overwrites the
// @context array deterministically and removes proof/verifiableCredential
// before hashing.
//
// Without this, a re-sign of an already-signed quote would canonicalize
// the stale proof's predicates into the hash and produce bytes no
// verifier on the network would reconstruct.
func TestSign_StripsPreExistingProofAndContext(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	opts := SignOptions{
		VerificationMethod: "did:pkh:eip155:1:" + address + "#blockchainAccountId",
		ProofPurpose:       expectedProofPurpose,
		Created:            time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC),
	}

	bare := signFixtureDoc(address)
	withCarryover := signFixtureDoc(address)
	withCarryover["@context"] = []any{"https://some.other/context"}
	withCarryover["proof"] = map[string]any{"type": "EcdsaSecp256k1RecoverySignature2020", "jws": "stale..signature"}
	withCarryover["verifiableCredential"] = []any{}

	a, err := Sign(bare, priv, opts)
	if err != nil {
		t.Fatalf("bare Sign: %v", err)
	}
	b, err := Sign(withCarryover, priv, opts)
	if err != nil {
		t.Fatalf("carryover Sign: %v", err)
	}
	if string(a) != string(b) {
		t.Fatalf("strip regression: bare and carryover Sign output differ\n  bare:      %s\n  carryover: %s", a, b)
	}
}

// TestSign_RejectsBadOptions documents the up-front validation Sign
// applies. Each row exercises one trigger; missing any of these checks
// at sign time would push the error onto the verifier and only surface
// once a real quote got rejected in production.
func TestSign_RejectsBadOptions(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	doc := signFixtureDoc(address)
	good := SignOptions{
		VerificationMethod: "did:pkh:eip155:1:" + address + "#blockchainAccountId",
		ProofPurpose:       expectedProofPurpose,
		Created:            time.Now(),
	}

	cases := []struct {
		name string
		opts SignOptions
		want string
	}{
		{"missing verificationMethod", SignOptions{ProofPurpose: expectedProofPurpose, Created: good.Created}, "verificationMethod required"},
		{"missing proofPurpose", SignOptions{VerificationMethod: good.VerificationMethod, Created: good.Created}, "proofPurpose required"},
		{"wrong proofPurpose", SignOptions{VerificationMethod: good.VerificationMethod, ProofPurpose: "authentication", Created: good.Created}, "not allowed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Sign(doc, priv, tc.opts)
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want substring %q", err, tc.want)
			}
		})
	}
	if _, err := Sign(doc, (*ecdsa.PrivateKey)(nil), good); err == nil {
		t.Fatal("expected error for nil private key")
	}
}

// TestSign_RejectsCallerSuppliedVC pins the fail-loud contract: the base
// signer covers quote terms only, so a non-empty verifiableCredential must
// be rejected rather than silently dropped. Both cryptosuites share the
// guard. An empty verifiableCredential stays accepted (see the carryover
// test), matching the empty slot the wire form reserves.
func TestSign_RejectsCallerSuppliedVC(t *testing.T) {
	secpPriv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	address := strings.ToLower(crypto.PubkeyToAddress(secpPriv.PublicKey).Hex())

	edPub, edPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey ed25519: %v", err)
	}
	edPubBase58 := base58.Encode(edPub)

	vc := []any{map[string]any{"type": []any{"VerifiableCredential"}, "issuer": "did:example:issuer"}}

	t.Run("secp256k1", func(t *testing.T) {
		doc := signFixtureDoc(address)
		doc["verifiableCredential"] = vc
		_, err := Sign(doc, secpPriv, SignOptions{
			VerificationMethod: "did:pkh:eip155:1:" + address + "#blockchainAccountId",
			ProofPurpose:       expectedProofPurpose,
			Created:            time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC),
		})
		if err == nil || !strings.Contains(err.Error(), "does not carry verifiableCredential") {
			t.Fatalf("expected verifiableCredential rejection, got %v", err)
		}
	})

	t.Run("ed25519", func(t *testing.T) {
		doc := signFixtureDoc(address)
		doc["verifiableCredential"] = vc
		_, err := SignEd25519(doc, edPriv, SignEd25519Options{
			VerificationMethod: "did:pkh:solana:devnet:" + edPubBase58 + "#blockchainAccountId",
			ProofPurpose:       expectedProofPurpose,
			Created:            time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC),
		})
		if err == nil || !strings.Contains(err.Error(), "does not carry verifiableCredential") {
			t.Fatalf("expected verifiableCredential rejection, got %v", err)
		}
	})
}

// TestSignEd25519_RoundTripsThroughVerify is the ed25519 counterpart of
// TestSign_RoundTripsThroughVerify. Result.Signer must be a
// SelfAssertedEd25519Signer whose PublicKey matches the keypair's public half.
func TestSignEd25519_RoundTripsThroughVerify(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBase58 := base58.Encode(pub)

	doc := map[string]any{
		"version":        "1.0",
		"source_amount":  "1000000",
		"award_deadline": "2030-01-01T00:00:00Z",
		"source": map[string]any{
			"id":      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
			"account": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:" + pubBase58,
		},
		"destination": map[string]any{
			"id":      "eip155:1/erc20:0xbbb",
			"account": "eip155:1:0x2",
		},
		"settler_address":      pubBase58,
		"payment_request_json": `{"request_id":"req-sol-1"}`,
	}

	signed, err := SignEd25519(doc, priv, SignEd25519Options{
		VerificationMethod: "did:pkh:solana:devnet:" + pubBase58 + "#blockchainAccountId",
		ProofPurpose:       expectedProofPurpose,
		Created:            time.Date(2026, 4, 29, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("SignEd25519: %v", err)
	}

	res, err := Verify(signed)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !mustEd25519Signer(t, res).PublicKey.Equal(pub) {
		t.Errorf("Ed25519PublicKey mismatch")
	}
}

// TestSign_OutputMatchesTestHelper proves the public API is a strict
// drop-in for signForTest: feeding the same inputs to both produces
// byte-identical signed JSON. Without this, the refactor that will
// eventually delete signForTest could quietly change the wire format
// and break cross-language fixture lock.
//
// The keypair is generated fresh per run but the signing inputs are
// deterministic, so the only sources of nondeterminism are the
// signature randomness (signForTest uses the same crypto.Sign path)
// and any JSON map-ordering. We check field-by-field equality rather
// than byte-equality because go's json.Marshal sorts map keys
// alphabetically, so both outputs end up with the same key order
// anyway — but a field-level compare is a cleaner assertion.
func TestSign_OutputMatchesTestHelper(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	createdStr := "2026-04-01T00:00:00.000Z"

	publicSigned, err := SignWithCreatedString(
		signFixtureDoc(strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())),
		priv,
		SignOptions{
			VerificationMethod: "did:pkh:eip155:1:" + strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex()) + "#blockchainAccountId",
			ProofPurpose:       expectedProofPurpose,
		},
		createdStr,
	)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	helperSigned := signForTestWithCreatedString(t, priv, createdStr)

	var pub, help map[string]any
	if err := json.Unmarshal(publicSigned, &pub); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(helperSigned, &help); err != nil {
		t.Fatal(err)
	}

	// Compare each top-level field except `proof.jws` (the JWS contains
	// a fresh random k per signature so the two are necessarily distinct
	// byte sequences while still being valid signatures over the same
	// signing input — Verify catches both, which is what TestSign_RoundTripsThroughVerify
	// covers). Everything else MUST match byte-for-byte.
	pubProof := pub["proof"].(map[string]any)
	helpProof := help["proof"].(map[string]any)
	delete(pubProof, "jws")
	delete(helpProof, "jws")

	pubJSON, _ := json.Marshal(pub)
	helpJSON, _ := json.Marshal(help)
	if string(pubJSON) != string(helpJSON) {
		t.Fatalf("public Sign output diverged from signForTest helper\n  public: %s\n  helper: %s", pubJSON, helpJSON)
	}
}
