package ldverification

import (
	"errors"
	"strings"
	"testing"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/crypto"
)

// testSigningDigest returns the digest a fixture signs: the legacy signing input, or the
// SettlerProof typed digest over the same proofHash and docHash.
func testSigningDigest(t *testing.T, hash HashResult, settlerProof bool) []byte {
	t.Helper()
	if !settlerProof {
		return hash.SigningInput
	}
	digest, err := lddataintegrity.SettlerProofTypedDigest(hash.ProofHash, hash.DocHash)
	if err != nil {
		t.Fatalf("SettlerProofTypedDigest: %v", err)
	}
	return digest
}

func TestVerify_Secp256k1_AcceptsSettlerProofTypedSignature(t *testing.T) {
	priv := newSecpKey(t)
	want := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	legacy := signQuoteForTest(t, priv, priv, "2026-04-01T00:00:00.000Z", false)
	typed := signQuoteForTest(t, priv, priv, "2026-04-01T00:00:00.000Z", true)
	lr, err := Verify(legacy)
	if err != nil {
		t.Fatalf("legacy Verify: %v", err)
	}

	for name, signed := range map[string][]byte{"legacy": legacy, "typed": typed} {
		res, err := Verify(signed)
		if err != nil {
			t.Fatalf("%s: Verify: %v", name, err)
		}
		if got := strings.ToLower(mustSecp256k1Signer(t, res).Hex()); got != want {
			t.Errorf("%s: recovered %s, want %s", name, got, want)
		}
		// quote_hash stays keccak256(SigningInput) regardless of which digest was signed.
		if res.QuoteHash != lr.QuoteHash {
			t.Errorf("%s: QuoteHash %s differs from legacy %s", name, res.QuoteHash, lr.QuoteHash)
		}
	}
}

func TestVerify_Secp256k1_SettlerProofTypedSignatureByWrongKey(t *testing.T) {
	identity := newSecpKey(t)
	attacker := newSecpKey(t)
	want := strings.ToLower(crypto.PubkeyToAddress(identity.PublicKey).Hex())
	signed := signQuoteForTest(t, identity, attacker, "2026-04-01T00:00:00.000Z", true)

	res, err := Verify(signed)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got := strings.ToLower(mustSecp256k1Signer(t, res).Hex()); got == want {
		t.Fatal("a typed signature by another key recovered the quote's settler")
	}
}

func TestVerifyVP_Secp256k1_AcceptsSettlerProofTypedSignature(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{SettlerProof: true})
	res, err := VerifyVP(envelope, happyOpts(holder))
	if err != nil {
		t.Fatalf("VerifyVP: %v", err)
	}
	if strings.ToLower(res.SignerAddress.Hex()) != addr {
		t.Fatalf("SignerAddress = %s, want %s", res.SignerAddress.Hex(), addr)
	}
}

func TestVerifyVP_Secp256k1_RejectsSettlerProofTypedSignatureByWrongKey(t *testing.T) {
	attacker := newSecpKey(t)
	victim := newSecpKey(t)
	victimHolder := "did:pkh:eip155:1:" + strings.ToLower(crypto.PubkeyToAddress(victim.PublicKey).Hex())

	envelope := signVPSecpForTest(t, attacker, vpFixtureOptions{
		Holder:             victimHolder,
		VerificationMethod: victimHolder + "#blockchainAccountId",
		SettlerProof:       true,
	})
	_, err := VerifyVP(envelope, happyOpts(victimHolder))
	if !errors.Is(err, ErrVPSignerHolderMismatch) {
		t.Fatalf("expected ErrVPSignerHolderMismatch, got %v", err)
	}
}
