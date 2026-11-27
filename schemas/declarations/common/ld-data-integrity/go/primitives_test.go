package lddataintegrity

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/asn1"
	"errors"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
)

// TestBuildAndParseSecp256k1JWS_Roundtrip pins the symmetry between the
// builder and parser: any 65-byte signature MUST roundtrip through
// BuildSecp256k1JWS → ParseSecp256k1JWS to the same bytes, with the
// header populated to the W3C-required (alg=ES256K-R, b64=false, crit=[b64])
// shape.
func TestBuildAndParseSecp256k1JWS_Roundtrip(t *testing.T) {
	sig := make([]byte, 65)
	for i := range sig {
		sig[i] = byte(i)
	}
	jws, err := BuildSecp256k1JWS(sig)
	if err != nil {
		t.Fatalf("BuildSecp256k1JWS: %v", err)
	}
	if !strings.Contains(jws, "..") {
		t.Errorf("JWS doesn't contain detached payload separator '..': %q", jws)
	}
	header, parsed, err := ParseSecp256k1JWS(jws)
	if err != nil {
		t.Fatalf("ParseSecp256k1JWS: %v", err)
	}
	if header.Alg != "ES256K-R" {
		t.Errorf("alg = %q, want ES256K-R", header.Alg)
	}
	if header.B64 {
		t.Error("b64 = true, want false for detached JWS")
	}
	if len(header.Crit) != 1 || header.Crit[0] != "b64" {
		t.Errorf("crit = %v, want [b64]", header.Crit)
	}
	if !bytes.Equal(parsed, sig) {
		t.Errorf("parsed signature bytes don't roundtrip")
	}
}

// TestBuildSecp256k1JWS_RejectsBadLength pins the defensive caller-
// error check at the build boundary: a non-65-byte signature is
// rejected at construction, not silently encoded into a malformed JWS.
func TestBuildSecp256k1JWS_RejectsBadLength(t *testing.T) {
	for _, n := range []int{0, 63, 64, 66, 128} {
		if _, err := BuildSecp256k1JWS(make([]byte, n)); err == nil {
			t.Errorf("BuildSecp256k1JWS with %d-byte sig returned nil err — defensive guard regressed", n)
		} else if !errors.Is(err, ErrMalformedProof) {
			t.Errorf("BuildSecp256k1JWS(%d bytes) err = %v, want errors.Is(ErrMalformedProof)", n, err)
		}
	}
}

// TestParseSecp256k1JWS_RejectsBadAlg pins the strict-validator
// invariant: a JWS with alg != ES256K-R MUST be rejected so a
// cross-cryptosuite confusion attack can't slip a non-recoverable
// signature into the recovery path.
func TestParseSecp256k1JWS_RejectsBadAlg(t *testing.T) {
	// Construct a malformed JWS with alg=HS256 instead of ES256K-R.
	// base64url("{\"alg\":\"HS256\",\"b64\":false,\"crit\":[\"b64\"]}")
	badJWS := "eyJhbGciOiJIUzI1NiIsImI2NCI6ZmFsc2UsImNyaXQiOlsiYjY0Il19.." +
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	if _, _, err := ParseSecp256k1JWS(badJWS); err == nil {
		t.Fatal("ParseSecp256k1JWS accepted JWS with alg=HS256 — cryptosuite confusion possible")
	} else if !errors.Is(err, ErrMalformedProof) {
		t.Errorf("err = %v, want errors.Is(ErrMalformedProof)", err)
	}
}

// TestRecoverSecp256k1Signer_Roundtrip pins the full sign-then-recover
// path: a known private key signs a known hash via crypto.Sign,
// RecoverSecp256k1Signer recovers the EVM address, which MUST equal
// the address derived from the public key.
func TestRecoverSecp256k1Signer_Roundtrip(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	expectedAddr := crypto.PubkeyToAddress(priv.PublicKey)

	// Some deterministic 32-byte hash to sign.
	hash := crypto.Keccak256([]byte("lddataintegrity test vector"))
	sig, err := crypto.Sign(hash, priv)
	if err != nil {
		t.Fatalf("crypto.Sign: %v", err)
	}

	recovered, err := RecoverSecp256k1Signer(hash, sig)
	if err != nil {
		t.Fatalf("RecoverSecp256k1Signer: %v", err)
	}
	if recovered != expectedAddr {
		t.Errorf("recovered = %s, want %s", recovered.Hex(), expectedAddr.Hex())
	}
}

// TestRecoverSecp256k1Signer_RejectsHighS pins cross-language agreement
// with the TS sibling: a valid low-s
// signature recovers, but its malleable high-s "twin" (r, N-s with the
// recovery bit flipped) MUST be rejected. ethers — and therefore the TS
// recoverSecp256k1Signer — rejects the twin; without the high-s guard
// go-ethereum's SigToPub would accept it, so Go and TS would give
// different yes/no answers for the same bytes.
func TestRecoverSecp256k1Signer_RejectsHighS(t *testing.T) {
	priv, _ := crypto.GenerateKey()
	hash := crypto.Keccak256([]byte("high-s twin test"))
	sig, err := crypto.Sign(hash, priv) // go-ethereum emits canonical low-s
	if err != nil {
		t.Fatalf("crypto.Sign: %v", err)
	}

	// The low-s original still recovers (guard didn't break the happy path).
	if _, err := RecoverSecp256k1Signer(hash, sig); err != nil {
		t.Fatalf("low-s signature unexpectedly rejected: %v", err)
	}

	// Build the high-s twin: s' = N - s, flip the recovery bit.
	s := new(big.Int).SetBytes(sig[32:64])
	twinS := new(big.Int).Sub(secp256k1N, s)
	if twinS.Cmp(secp256k1HalfN) <= 0 {
		t.Fatalf("twin s is not high-s (s'=%s); invalid test vector", twinS)
	}
	twin := make([]byte, 65)
	copy(twin[:32], sig[:32]) // r unchanged
	twinS.FillBytes(twin[32:64])
	twin[64] = sig[64] ^ 0x01 // flip v ∈ {0,1}

	if _, err := RecoverSecp256k1Signer(hash, twin); err == nil {
		t.Fatal("high-s twin accepted; expected rejection to match the TS verifier")
	} else if !errors.Is(err, ErrSignatureRecovery) {
		t.Errorf("high-s rejection err = %v, want ErrSignatureRecovery", err)
	}
}

// TestRecoverSecp256k1Signer_AcceptsBothVByteForms pins the EIP-191
// compat path: signatures with v in {27,28} (some signer libraries
// emit this) MUST recover the same address as v in {0,1}.
func TestRecoverSecp256k1Signer_AcceptsBothVByteForms(t *testing.T) {
	priv, _ := crypto.GenerateKey()
	hash := crypto.Keccak256([]byte("v-byte normalization test"))
	sig, err := crypto.Sign(hash, priv)
	if err != nil {
		t.Fatalf("crypto.Sign: %v", err)
	}
	// crypto.Sign returns v in {0,1}; build a {27,28} variant.
	sig27 := make([]byte, 65)
	copy(sig27, sig)
	sig27[64] += 27

	addr01, err := RecoverSecp256k1Signer(hash, sig)
	if err != nil {
		t.Fatalf("recover with v in {0,1}: %v", err)
	}
	addr27, err := RecoverSecp256k1Signer(hash, sig27)
	if err != nil {
		t.Fatalf("recover with v in {27,28}: %v", err)
	}
	if addr01 != addr27 {
		t.Errorf("v-byte normalization broken: %s vs %s", addr01.Hex(), addr27.Hex())
	}
}

// TestRecoverSecp256k1Signer_RefusesOtherVBytes walks every v byte: only 0,
// 1, 27 and 28 recover, as in the TS sibling. Left to go-ethereum, a build
// without cgo also recovered the signer from 4, 5, 31 and 32, and a build
// with cgo refused them with its own error, so each refusal must be this
// function's.
func TestRecoverSecp256k1Signer_RefusesOtherVBytes(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	signer := crypto.PubkeyToAddress(priv.PublicKey)
	hash := crypto.Keccak256([]byte("v-byte walk"))
	sig, err := crypto.Sign(hash, priv)
	if err != nil {
		t.Fatalf("crypto.Sign: %v", err)
	}
	recID := int(sig[64])
	for v := 0; v <= 255; v++ {
		withV := make([]byte, 65)
		copy(withV, sig)
		withV[64] = byte(v)
		addr, err := RecoverSecp256k1Signer(hash, withV)
		switch {
		case v == recID || v == recID+27:
			if err != nil || addr != signer {
				t.Errorf("v=%d: got (%s, %v), want the signer %s", v, addr.Hex(), err, signer.Hex())
			}
		case v == 0 || v == 1 || v == 27 || v == 28:
			// The other parity is a well-formed signature by some other key.
			if err == nil && addr == signer {
				t.Errorf("v=%d: the other parity recovered the signer", v)
			}
		default:
			if !errors.Is(err, ErrSignatureRecovery) || !strings.Contains(err.Error(), "recovery byte") {
				t.Errorf("v=%d: got (%s, %v), want this function's ErrSignatureRecovery for the recovery byte", v, addr.Hex(), err)
			}
		}
	}
}

// TestEd25519_SignVerify_Roundtrip pins the ed25519 cryptosuite path:
// SignEd25519 → VerifyEd25519 over the same input + key MUST succeed.
func TestEd25519_SignVerify_Roundtrip(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	msg := []byte("lddataintegrity ed25519 test vector")
	sig := SignEd25519(priv, msg)
	if len(sig) != ed25519.SignatureSize {
		t.Fatalf("signature size = %d, want %d", len(sig), ed25519.SignatureSize)
	}
	if err := VerifyEd25519(pub, msg, sig); err != nil {
		t.Errorf("VerifyEd25519 over valid sig: %v", err)
	}
}

// TestEd25519_Verify_RejectsTamperedSignature pins the typed-error
// surface: a tampered signature MUST return ErrEd25519Verify (not nil,
// not a generic error) so callers can classify via errors.Is.
func TestEd25519_Verify_RejectsTamperedSignature(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	msg := []byte("tampered-signature test")
	sig := SignEd25519(priv, msg)
	sig[0] ^= 0xFF // flip the first byte
	err := VerifyEd25519(pub, msg, sig)
	if err == nil {
		t.Fatal("VerifyEd25519 accepted tampered signature")
	}
	if !errors.Is(err, ErrEd25519Verify) {
		t.Errorf("err = %v, want errors.Is(ErrEd25519Verify)", err)
	}
}

// TestEncodeDecodeEd25519ProofValue_Roundtrip pins the multibase
// z-base58btc encoding contract: encode-then-decode of any 64-byte
// signature MUST roundtrip byte-equal.
func TestEncodeDecodeEd25519ProofValue_Roundtrip(t *testing.T) {
	sig := make([]byte, ed25519.SignatureSize)
	for i := range sig {
		sig[i] = byte(i ^ 0xA5)
	}
	encoded, err := EncodeEd25519ProofValue(sig)
	if err != nil {
		t.Fatalf("EncodeEd25519ProofValue: %v", err)
	}
	if !strings.HasPrefix(encoded, "z") {
		t.Errorf("encoded proofValue = %q, want 'z' multibase prefix", encoded)
	}
	decoded, err := DecodeEd25519ProofValue(encoded)
	if err != nil {
		t.Fatalf("DecodeEd25519ProofValue: %v", err)
	}
	if !bytes.Equal(decoded, sig) {
		t.Error("ed25519 proofValue roundtrip bytes don't match")
	}
}

// TestDecodeEd25519ProofValue_RejectsBadPrefix pins the multibase
// invariant: any prefix other than 'z' MUST be rejected — the
// cryptosuite spec is z-base58btc only.
func TestDecodeEd25519ProofValue_RejectsBadPrefix(t *testing.T) {
	if _, err := DecodeEd25519ProofValue("f001122"); err == nil {
		t.Error("DecodeEd25519ProofValue accepted non-'z' multibase prefix")
	}
	if _, err := DecodeEd25519ProofValue(""); err == nil {
		t.Error("DecodeEd25519ProofValue accepted empty string")
	}
}

// TestHashDocument_Secp256k1Dispatch pins the secp256k1 cryptosuite
// path: HashDocument with cryptosuite=EcdsaSecp256k1RecoverySignature2020
// MUST produce a 32-byte signing input (keccak256 output) and 32-byte
// per-hash outputs.
func TestHashDocument_Secp256k1Dispatch(t *testing.T) {
	loader := NewDocumentLoader(nil)
	doc := map[string]any{
		"@context": []any{W3CVCV1ContextURL},
		"type":     []any{"VerifiableCredential"},
		"issuer":   "did:web:example.com",
	}
	opts := HashOptions{
		Cryptosuite: CryptosuiteSecp256k1Recovery2020,
		ProofOptions: ProofOptions{
			Type:               CryptosuiteSecp256k1Recovery2020,
			Created:            "2026-01-01T00:00:00Z",
			VerificationMethod: "did:pkh:eip155:1:0x0000000000000000000000000000000000000000#blockchainAccountId",
			ProofPurpose:       "assertionMethod",
		},
	}
	res, err := HashDocument(doc, opts, loader)
	if err != nil {
		t.Fatalf("HashDocument: %v", err)
	}
	if len(res.SigningInput) != 32 {
		t.Errorf("SigningInput len = %d, want 32 (keccak256 output)", len(res.SigningInput))
	}
	if len(res.DocHash) != 32 || len(res.ProofHash) != 32 {
		t.Errorf("hashes len: doc=%d proof=%d, want 32 each", len(res.DocHash), len(res.ProofHash))
	}
	if res.Cryptosuite != CryptosuiteSecp256k1Recovery2020 {
		t.Errorf("Cryptosuite = %q, want %q", res.Cryptosuite, CryptosuiteSecp256k1Recovery2020)
	}
}

// TestHashDocument_Ed25519Dispatch pins the ed25519 cryptosuite path:
// 64-byte signing input (32-byte proofHash || 32-byte docHash).
func TestHashDocument_Ed25519Dispatch(t *testing.T) {
	loader := NewDocumentLoader(nil)
	doc := map[string]any{
		"@context": []any{W3CVCV1ContextURL},
		"type":     []any{"VerifiableCredential"},
		"issuer":   "did:web:example.com",
	}
	opts := HashOptions{
		Cryptosuite: CryptosuiteEd25519Signature2020,
		ProofOptions: ProofOptions{
			Type:               CryptosuiteEd25519Signature2020,
			Created:            "2026-01-01T00:00:00Z",
			VerificationMethod: "did:web:example.com#key-1",
			ProofPurpose:       "assertionMethod",
		},
	}
	res, err := HashDocument(doc, opts, loader)
	if err != nil {
		t.Fatalf("HashDocument: %v", err)
	}
	if len(res.SigningInput) != 64 {
		t.Errorf("SigningInput len = %d, want 64 (proofHash || docHash)", len(res.SigningInput))
	}
	if len(res.DocHash) != 32 || len(res.ProofHash) != 32 {
		t.Errorf("hashes len: doc=%d proof=%d, want 32 each (SHA-256 output)", len(res.DocHash), len(res.ProofHash))
	}
}

// TestHashDocument_RejectsUnsupportedCryptosuite pins the dispatch
// guard: an unknown cryptosuite must fail closed with
// ErrUnsupportedProofType (not silently fall through).
func TestHashDocument_RejectsUnsupportedCryptosuite(t *testing.T) {
	loader := NewDocumentLoader(nil)
	doc := map[string]any{"@context": []any{W3CVCV1ContextURL}}
	opts := HashOptions{
		Cryptosuite: "FuturisticSignature9999",
		ProofOptions: ProofOptions{
			Type: "FuturisticSignature9999",
		},
	}
	if _, err := HashDocument(doc, opts, loader); err == nil {
		t.Fatal("HashDocument accepted unsupported cryptosuite")
	} else if !errors.Is(err, ErrUnsupportedProofType) {
		t.Errorf("err = %v, want errors.Is(ErrUnsupportedProofType)", err)
	}
}

// TestHashDocument_RejectsTypeMismatch pins the cheap typo guard: a
// ProofOptions.Type that doesn't match the dispatch Cryptosuite must
// fail closed with ErrMalformedProof.
func TestHashDocument_RejectsTypeMismatch(t *testing.T) {
	loader := NewDocumentLoader(nil)
	doc := map[string]any{"@context": []any{W3CVCV1ContextURL}}
	opts := HashOptions{
		Cryptosuite: CryptosuiteSecp256k1Recovery2020,
		ProofOptions: ProofOptions{
			Type: CryptosuiteEd25519Signature2020,
		},
	}
	if _, err := HashDocument(doc, opts, loader); err == nil {
		t.Fatal("HashDocument accepted mismatched proof type / cryptosuite")
	} else if !errors.Is(err, ErrMalformedProof) {
		t.Errorf("err = %v, want errors.Is(ErrMalformedProof)", err)
	}
}

// TestSecp256k1ESRecoveryFromDER_Roundtrip pins the KMS-flow helper:
// a freshly-signed DER signature, plus the expected uncompressed
// pubkey, recovers to a 65-byte ES256K-R signature whose v byte
// reproduces the same pubkey via crypto.Ecrecover. This is the
// path KMS-backed signers take.
func TestSecp256k1ESRecoveryFromDER_Roundtrip(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	expectedPub := crypto.FromECDSAPub(&priv.PublicKey)
	digest := crypto.Keccak256([]byte("test-message"))

	// Build a DER signature the way AWS KMS / GCP KMS would.
	rawSig, err := crypto.Sign(digest, priv)
	if err != nil {
		t.Fatalf("crypto.Sign: %v", err)
	}
	r := new(big.Int).SetBytes(rawSig[:32])
	s := new(big.Int).SetBytes(rawSig[32:64])
	der, err := asn1.Marshal(ecdsaSig{R: r, S: s})
	if err != nil {
		t.Fatalf("asn1.Marshal: %v", err)
	}

	sig65, err := Secp256k1ESRecoveryFromDER(der, expectedPub, digest)
	if err != nil {
		t.Fatalf("Secp256k1ESRecoveryFromDER: %v", err)
	}
	if len(sig65) != 65 {
		t.Errorf("recovered sig len = %d, want 65", len(sig65))
	}

	// Verify the recovery byte is in {0,1} and the recovered pubkey
	// matches expectedPub byte-for-byte.
	if sig65[64] > 1 {
		t.Errorf("recovery byte v = %d, want 0 or 1", sig65[64])
	}
	recovered, err := crypto.Ecrecover(digest, sig65)
	if err != nil {
		t.Fatalf("crypto.Ecrecover on result: %v", err)
	}
	if !bytes.Equal(recovered, expectedPub) {
		t.Errorf("recovered pubkey does not match expectedPub")
	}
}

// TestSecp256k1ESRecoveryFromDER_RejectsWrongKey pins the
// disambiguation guard: if the caller passes a pubkey that doesn't
// correspond to the signing key, neither v=0 nor v=1 recovers a
// match — must surface ErrSignatureRecovery.
func TestSecp256k1ESRecoveryFromDER_RejectsWrongKey(t *testing.T) {
	signingKey, _ := crypto.GenerateKey()
	wrongKey, _ := crypto.GenerateKey()
	wrongPub := crypto.FromECDSAPub(&wrongKey.PublicKey)
	digest := crypto.Keccak256([]byte("test-message"))

	rawSig, _ := crypto.Sign(digest, signingKey)
	r := new(big.Int).SetBytes(rawSig[:32])
	s := new(big.Int).SetBytes(rawSig[32:64])
	der, _ := asn1.Marshal(ecdsaSig{R: r, S: s})

	_, err := Secp256k1ESRecoveryFromDER(der, wrongPub, digest)
	if err == nil {
		t.Fatal("expected error for mismatched key, got nil")
	}
	if !errors.Is(err, ErrSignatureRecovery) {
		t.Errorf("err = %v, want errors.Is(ErrSignatureRecovery)", err)
	}
}

// TestSecp256k1ESRecoveryFromDER_RejectsBadInputs pins the defensive
// caller-error guards (digest length, expectedPub shape) that fail
// closed before any recovery attempt.
func TestSecp256k1ESRecoveryFromDER_RejectsBadInputs(t *testing.T) {
	priv, _ := crypto.GenerateKey()
	expectedPub := crypto.FromECDSAPub(&priv.PublicKey)
	digest := crypto.Keccak256([]byte("ok"))
	rawSig, _ := crypto.Sign(digest, priv)
	r := new(big.Int).SetBytes(rawSig[:32])
	s := new(big.Int).SetBytes(rawSig[32:64])
	der, _ := asn1.Marshal(ecdsaSig{R: r, S: s})

	cases := []struct {
		name        string
		der         []byte
		expectedPub []byte
		digest      []byte
	}{
		{"short digest", der, expectedPub, digest[:16]},
		{"wrong-shape pub (32 bytes)", der, expectedPub[:32], digest},
		{"non-uncompressed pub", der, append([]byte{0x02}, expectedPub[1:]...), digest},
		{"malformed DER", []byte{0x30, 0x00}, expectedPub, digest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Secp256k1ESRecoveryFromDER(tc.der, tc.expectedPub, tc.digest)
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if !errors.Is(err, ErrMalformedProof) {
				t.Errorf("err = %v, want errors.Is(ErrMalformedProof)", err)
			}
		})
	}
}

// TestSecp256k1ESRecoveryFromDER_RejectsLongFormDER pins the
// short-form-only DER parser constraint added in the self-audit.
// secp256k1 sigs always fit in short form (≤127-byte payload); a
// long-form input (length byte high bit set) is rejected explicitly
// so behavior matches the TS sibling and operator diagnostics stay
// clear (instead of an asn1.Unmarshal error that doesn't surface the
// long-form-vs-short-form distinction).
func TestSecp256k1ESRecoveryFromDER_RejectsLongFormDER(t *testing.T) {
	priv, _ := crypto.GenerateKey()
	expectedPub := crypto.FromECDSAPub(&priv.PublicKey)
	digest := crypto.Keccak256([]byte("long-form-fixture"))

	rawSig, _ := crypto.Sign(digest, priv)
	r := new(big.Int).SetBytes(rawSig[:32])
	s := new(big.Int).SetBytes(rawSig[32:64])
	validDER, _ := asn1.Marshal(ecdsaSig{R: r, S: s})

	// Reshape to long-form: replace the short-form SEQUENCE length
	// byte (validDER[1]) with the long-form indicator + 1-byte length.
	longFormDER := make([]byte, 0, len(validDER)+1)
	longFormDER = append(longFormDER, 0x30, 0x81, validDER[1])
	longFormDER = append(longFormDER, validDER[2:]...)

	_, err := Secp256k1ESRecoveryFromDER(longFormDER, expectedPub, digest)
	if err == nil {
		t.Fatal("expected long-form DER to be rejected, got nil")
	}
	if !errors.Is(err, ErrMalformedProof) {
		t.Errorf("err = %v, want errors.Is(ErrMalformedProof)", err)
	}
	if !strings.Contains(err.Error(), "long-form") {
		t.Errorf("err = %v, want it to mention 'long-form'", err)
	}
}

// TestSecp256k1ESRecoveryFromDER_RejectsOutOfRangeRS pins the
// post-self-audit r/s bound check. The DER parser refuses r ≥ N or
// s ≥ N at parse time rather than letting the recovery loop fail
// with a misleading "neither v recovers expectedPub" downstream.
// Constructed-DER input — an attacker-controlled (or buggy KMS)
// signature with r at exactly the secp256k1 group order N.
func TestSecp256k1ESRecoveryFromDER_RejectsOutOfRangeRS(t *testing.T) {
	priv, _ := crypto.GenerateKey()
	expectedPub := crypto.FromECDSAPub(&priv.PublicKey)
	digest := crypto.Keccak256([]byte("oob-fixture"))

	cases := []struct {
		name string
		r    *big.Int
		s    *big.Int
	}{
		{"r == N", new(big.Int).Set(secp256k1N), big.NewInt(1)},
		{"s == N", big.NewInt(1), new(big.Int).Set(secp256k1N)},
		{"r > N", new(big.Int).Add(secp256k1N, big.NewInt(1)), big.NewInt(1)},
		{"s > N", big.NewInt(1), new(big.Int).Add(secp256k1N, big.NewInt(1))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			der, err := asn1.Marshal(ecdsaSig{R: tc.r, S: tc.s})
			if err != nil {
				t.Fatalf("asn1.Marshal: %v", err)
			}
			_, err = Secp256k1ESRecoveryFromDER(der, expectedPub, digest)
			if err == nil {
				t.Fatalf("expected out-of-range r/s to be rejected, got nil")
			}
			if !errors.Is(err, ErrMalformedProof) {
				t.Errorf("err = %v, want errors.Is(ErrMalformedProof)", err)
			}
			if !strings.Contains(err.Error(), "out of range") {
				t.Errorf("err = %v, want it to mention 'out of range'", err)
			}
		})
	}
}

// TestSecp256k1ESRecoveryFromDER_NormalizesHighS pins the EIP-2 / low-s
// canonicalization branch in Secp256k1ESRecoveryFromDER. crypto.Sign
// always produces low-s output, so the previous tests exercise the
// happy path but never the s > N/2 branch. Cloud KMS backends (AWS,
// GCP) produce non-normalized s ~50% of the time; without this guard
// the helper would silently emit malleable sigs that downstream
// Ethereum-flavored verifiers reject.
//
// The test pre-flips s to (N - s) by hand to construct a DER with
// guaranteed-high s + the same elliptic point. The helper MUST
// re-flip back to low-s and still recover expectedPub.
func TestSecp256k1ESRecoveryFromDER_NormalizesHighS(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	expectedPub := crypto.FromECDSAPub(&priv.PublicKey)
	digest := crypto.Keccak256([]byte("high-s-fixture"))

	rawSig, err := crypto.Sign(digest, priv)
	if err != nil {
		t.Fatalf("crypto.Sign: %v", err)
	}
	r := new(big.Int).SetBytes(rawSig[:32])
	sLow := new(big.Int).SetBytes(rawSig[32:64])
	// Flip s to (N - s) — same ECDSA point, opposite parity. By
	// construction sLow ≤ N/2 (crypto.Sign normalizes), so sHigh = N
	// - sLow > N/2.
	sHigh := new(big.Int).Sub(secp256k1N, sLow)
	if sHigh.Cmp(secp256k1HalfN) <= 0 {
		t.Fatalf("test setup failed: flipped s (%s) is not > N/2 (%s)", sHigh.String(), secp256k1HalfN.String())
	}
	derHighS, err := asn1.Marshal(ecdsaSig{R: r, S: sHigh})
	if err != nil {
		t.Fatalf("asn1.Marshal high-s: %v", err)
	}

	sig65, err := Secp256k1ESRecoveryFromDER(derHighS, expectedPub, digest)
	if err != nil {
		t.Fatalf("Secp256k1ESRecoveryFromDER with high-s DER: %v", err)
	}
	if len(sig65) != 65 {
		t.Fatalf("sig length = %d, want 65", len(sig65))
	}

	// The resulting sig's s component MUST be normalized back to low-s.
	sOut := new(big.Int).SetBytes(sig65[32:64])
	if sOut.Cmp(secp256k1HalfN) > 0 {
		t.Errorf("helper did not normalize s back to low-s; got %s, half-N is %s", sOut.String(), secp256k1HalfN.String())
	}

	// And recovery must still reproduce expectedPub.
	recovered, err := crypto.Ecrecover(digest, sig65)
	if err != nil {
		t.Fatalf("Ecrecover on normalized sig: %v", err)
	}
	if !bytes.Equal(recovered, expectedPub) {
		t.Errorf("recovered pubkey mismatch after high-s normalization")
	}
}
