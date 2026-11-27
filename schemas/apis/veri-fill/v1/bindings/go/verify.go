package verifill

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	"filippo.io/edwards25519"
	secp256k1ecdsa "github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"golang.org/x/crypto/sha3"
)

// This file is the other half of verdict.go. Deriving the preimage in a shared binding and
// leaving verification to each consumer would have preserved exactly the divergence the
// preimage was moved here to prevent: the rules below are the ones a second reading of the
// spec gets subtly wrong, and every one of them fails open when it is skipped.

// secp256k1CurveOrder is n for secp256k1, used for the low-s requirement. Written out rather
// than read from the curve so the constant a signature is judged against is visible here.
var secp256k1CurveOrder, _ = new(big.Int).SetString(
	"fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16)

// halfCurveOrder is n/2. A signature with s above it is the malleated twin of a valid one, so
// accepting both would let one verdict carry two distinct valid signatures.
var halfCurveOrder = new(big.Int).Rsh(secp256k1CurveOrder, 1)

// ed25519GroupOrder is L from RFC 8032, the bound a canonical S must fall below.
var ed25519GroupOrder, _ = new(big.Int).SetString(
	"1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed", 16)

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// base58Decode is hand-rolled so this binding stays free of an encoding dependency. Returns an
// error rather than a partial result on an out-of-alphabet byte, because a lenient decoder that
// skipped one would turn a corrupted address into a different valid-looking address.
func base58Decode(s string) ([]byte, error) {
	if s == "" {
		return nil, fmt.Errorf("empty base58 string")
	}
	n := new(big.Int)
	radix := big.NewInt(58)
	for i := 0; i < len(s); i++ {
		idx := strings.IndexByte(base58Alphabet, s[i])
		if idx < 0 {
			return nil, fmt.Errorf("byte %q at offset %d is not in the base58 alphabet", s[i], i)
		}
		n.Mul(n, radix)
		n.Add(n, big.NewInt(int64(idx)))
	}
	out := n.Bytes()
	// Each leading '1' encodes one leading zero byte, which n.Bytes() cannot represent.
	lead := 0
	for lead < len(s) && s[lead] == '1' {
		lead++
	}
	return append(make([]byte, lead), out...), nil
}

func keccak256(b ...[]byte) []byte {
	h := sha3.NewLegacyKeccak256()
	for _, p := range b {
		h.Write(p)
	}
	return h.Sum(nil)
}

// verdictDigest applies a preimage scheme's message convention to the preimage. The Tron
// prefix is selected from the scheme and never from the chain, so a signature under another
// prefix does not verify here.
func verdictDigest(scheme VerdictSignatureScheme, preimage string) ([]byte, error) {
	switch scheme {
	case VerdictSignatureSchemeTip191Secp256k1:
		// The length is in BYTES. It coincides with a code-unit length only because every
		// member's pattern is ASCII, so this must not be reimplemented with a string length.
		return keccak256([]byte("\x19TRON Signed Message:\n"), []byte(strconv.Itoa(len(preimage))), []byte(preimage)), nil
	case VerdictSignatureSchemeEd25519Raw:
		// Verified over the preimage bytes with no hashing step.
		return []byte(preimage), nil
	case VerdictSignatureSchemeEip712Secp256k1:
		return nil, fmt.Errorf("scheme %q signs typed data, not a preimage", scheme)
	default:
		return nil, fmt.Errorf("unrecognised signature scheme %q", scheme)
	}
}

// verdictSigningInput returns what a fulfillment verdict's scheme signs: the EIP-712 digest on
// eip712-secp256k1, and the preimage under its scheme's convention otherwise.
func verdictSigningInput(v *FulfillmentVerdict) ([]byte, error) {
	if v.SignatureScheme == VerdictSignatureSchemeEip712Secp256k1 {
		_, digest, err := eip712Encode(v.ChainId, fulfillmentVerdictPrimaryType, fulfillmentTypedMembers(v))
		return digest, err
	}
	preimage, err := VerdictSignedPayload(v)
	if err != nil {
		return nil, err
	}
	return verdictDigest(v.SignatureScheme, preimage)
}

// depositVerdictSigningInput is the same for a deposit verdict.
func depositVerdictSigningInput(v *DepositVerdict) ([]byte, error) {
	if v.SignatureScheme == VerdictSignatureSchemeEip712Secp256k1 {
		_, digest, err := eip712Encode(v.ChainId, depositVerdictPrimaryType, depositTypedMembers(v))
		return digest, err
	}
	preimage, err := DepositVerdictSignedPayload(v)
	if err != nil {
		return nil, err
	}
	return verdictDigest(v.SignatureScheme, preimage)
}

// VerdictSigningDigest returns the bytes a producer signs for v, which the verifier recomputes,
// so producer and consumer share one implementation of the scheme's rule. The verdict must
// already carry the one scheme its chain admits.
//
// On eip712-secp256k1 it is the EIP-712 digest of VerdictTypedData, and on tip191-secp256k1 the
// prefixed keccak256 of the preimage. On ed25519-raw it is the preimage bytes themselves, which
// are signed as they are rather than hashed first.
//
// It is derived for any verdict, so a producer MUST validate the signed verdict with
// ValidateVerdictMembers before emitting it.
func VerdictSigningDigest(v *FulfillmentVerdict) ([]byte, error) {
	if v == nil {
		return nil, fmt.Errorf("verdict is nil")
	}
	scheme, ok := VerdictSchemeForChain(v.ChainId)
	if !ok || scheme != v.SignatureScheme {
		return nil, fmt.Errorf("signature_scheme %q is not the scheme chain %q admits", v.SignatureScheme, v.ChainId)
	}
	return verdictSigningInput(v)
}

// DepositVerdictSigningDigest is VerdictSigningDigest for a deposit verdict: the EIP-712 digest
// of DepositVerdictTypedData on eip155, and the deposit preimage under its scheme otherwise.
// A producer MUST validate the signed verdict with ValidateDepositVerdictMembers before emitting it.
func DepositVerdictSigningDigest(v *DepositVerdict) ([]byte, error) {
	if v == nil {
		return nil, fmt.Errorf("deposit verdict is nil")
	}
	scheme, ok := VerdictSchemeForChain(v.ChainId)
	if !ok || scheme != v.SignatureScheme {
		return nil, fmt.Errorf("signature_scheme %q is not the scheme chain %q admits", v.SignatureScheme, v.ChainId)
	}
	return depositVerdictSigningInput(v)
}

// recoverSecp256k1 returns the recovered 20-byte account for a digest, applying both
// normalizations the schema requires: v is accepted in the {0,1} and {27,28} forms because both
// occur from different signing backends and both recover the same signer, and s must be low.
func recoverSecp256k1(digest []byte, sigHex string) ([]byte, error) {
	raw, err := hex.DecodeString(sigHex)
	if err != nil {
		return nil, fmt.Errorf("signature is not hex: %w", err)
	}
	if len(raw) != 65 {
		return nil, fmt.Errorf("signature is %d bytes, want 65 for r || s || v", len(raw))
	}

	s := new(big.Int).SetBytes(raw[32:64])
	if s.Sign() == 0 || s.Cmp(halfCurveOrder) > 0 {
		return nil, fmt.Errorf("signature s is not low-s, so it is the malleable twin of a valid signature")
	}
	if r := new(big.Int).SetBytes(raw[0:32]); r.Sign() == 0 || r.Cmp(secp256k1CurveOrder) >= 0 {
		return nil, fmt.Errorf("signature r is out of range")
	}

	v := raw[64]
	if v >= 27 {
		v -= 27
	}
	if v > 1 {
		return nil, fmt.Errorf("signature recovery byte %d is not 0 or 1 after normalization", raw[64])
	}

	// dcrec takes the recovery byte FIRST, and encodes "uncompressed key" by omitting the +4
	// that a compressed key would add.
	compact := make([]byte, 65)
	compact[0] = v + 27
	copy(compact[1:], raw[0:64])

	pub, _, err := secp256k1ecdsa.RecoverCompact(compact, digest)
	if err != nil {
		return nil, fmt.Errorf("signature does not recover a public key: %w", err)
	}
	uncompressed := pub.SerializeUncompressed() // 0x04 || X || Y
	return keccak256(uncompressed[1:])[12:], nil
}

// decodeServedEvmAddress validates the address the service published and returns its 20 bytes.
//
// The EIP-55 checksum is the ONLY integrity protection on a value fetched over the wire, so a
// mixed-case string whose checksum is wrong is refused rather than folded. All-lowercase and
// all-uppercase carry no checksum by definition and are accepted as-is.
func decodeServedEvmAddress(addr string) ([]byte, error) {
	if !strings.HasPrefix(addr, "0x") || len(addr) != 42 {
		return nil, fmt.Errorf("served address %q is not a 0x-prefixed 20-byte hex string", addr)
	}
	body := addr[2:]
	lower, upper := strings.ToLower(body), strings.ToUpper(body)
	if body != lower && body != upper {
		if !eip55Matches(lower, body) {
			return nil, fmt.Errorf("served address %q is mixed case and its EIP-55 checksum is wrong", addr)
		}
	}
	b, err := hex.DecodeString(lower)
	if err != nil {
		return nil, fmt.Errorf("served address %q is not hex: %w", addr, err)
	}
	return b, nil
}

func eip55Matches(lowerBody, actualBody string) bool {
	sum := hex.EncodeToString(keccak256([]byte(lowerBody)))
	for i := 0; i < len(lowerBody); i++ {
		c := lowerBody[i]
		if c < 'a' || c > 'f' {
			if actualBody[i] != c {
				return false
			}
			continue
		}
		want := c
		if sum[i] >= '8' {
			want = c - 32 // uppercase
		}
		if actualBody[i] != want {
			return false
		}
	}
	return true
}

// decodeServedTronAddress base58-decodes a served Tron address and returns its 20 account
// bytes.
//
// Plain base58 yields 25 bytes and not 21, so "strip the 0x41" must not be read as "take
// everything after byte 0": the trailing four bytes are a checksum, and including them would
// compare a 24-byte value against a 20-byte recovery and never match.
func decodeServedTronAddress(addr string) ([]byte, error) {
	raw, err := base58Decode(addr)
	if err != nil {
		return nil, fmt.Errorf("served address %q is not base58: %w", addr, err)
	}
	if len(raw) != 25 {
		return nil, fmt.Errorf("served address %q decodes to %d bytes, want exactly 25", addr, len(raw))
	}
	first := sha256.Sum256(raw[0:21])
	second := sha256.Sum256(first[:])
	if subtle.ConstantTimeCompare(raw[21:25], second[0:4]) != 1 {
		return nil, fmt.Errorf("served address %q has a bad base58check checksum", addr)
	}
	if raw[0] != 0x41 {
		return nil, fmt.Errorf("served address %q has version byte 0x%02x, want 0x41", addr, raw[0])
	}
	return raw[1:21], nil
}

// decodeServedEd25519Key base58-decodes a served Solana account and returns its 32 key bytes.
//
// The length is checked BEFORE the key reaches ed25519.Verify, because a short key makes some
// implementations panic rather than return false, and the small-order check happens here too: a
// signature under a small-order key verifies for any message at all.
func decodeServedEd25519Key(addr string) ([]byte, error) {
	raw, err := base58Decode(addr)
	if err != nil {
		return nil, fmt.Errorf("served address %q is not base58: %w", addr, err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("served address %q decodes to %d bytes, want exactly %d", addr, len(raw), ed25519.PublicKeySize)
	}

	// Decoding is itself the non-canonical-encoding check the schema requires alongside the
	// small-order one: SetBytes refuses a y coordinate at or above p, and refuses a value that is
	// not a point on the curve at all.
	point, err := edwards25519.NewIdentityPoint().SetBytes(raw)
	if err != nil {
		return nil, fmt.Errorf("served address %q is not a canonically encoded curve point: %w", addr, err)
	}

	// Small order means the cofactor multiple is the identity. COMPUTED rather than compared against
	// a list of known encodings: a transcribed list is one typo away from a gap that fails open, and
	// it can only ever cover the encodings someone remembered. This catches every small-order point,
	// including the ones a list would miss.
	if edwards25519.NewIdentityPoint().MultByCofactor(point).Equal(edwards25519.NewIdentityPoint()) == 1 {
		return nil, fmt.Errorf("served address %q is a small-order point, so a signature under it verifies for any message", addr)
	}
	return raw, nil
}

// verifyEd25519 checks the canonical-S requirement explicitly before verifying.
//
// This is normative rather than defensive: widely used Solana libraries omit the check while
// other implementations enforce it, so without it the same verdict, key and signature verify in
// one stack and fail in another, and any valid signature can be malleated into a second
// distinct signature over the same verdict.
//
// Go's crypto/ed25519 happens to enforce it too, so this is redundant HERE and load-bearing
// everywhere else. It is kept explicit anyway for two reasons: it is what the schema requires of
// every implementation, and it makes this binding name the reason rather than reporting a
// malleated signature as a plain verification failure.
func verifyEd25519(pub, message []byte, sigHex string) error {
	sig, err := hex.DecodeString(sigHex)
	if err != nil {
		return fmt.Errorf("signature is not hex: %w", err)
	}
	if len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("signature is %d bytes, want %d", len(sig), ed25519.SignatureSize)
	}
	// S is little-endian in the wire encoding, so reverse before reading it as an integer.
	le := make([]byte, 32)
	for i, b := range sig[32:64] {
		le[31-i] = b
	}
	if s := new(big.Int).SetBytes(le); s.Cmp(ed25519GroupOrder) >= 0 {
		return fmt.Errorf("signature S is not canonical per RFC 8032 5.1.7, so a second valid signature exists over this verdict")
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), message, sig) {
		return fmt.Errorf("signature does not verify under the served key")
	}
	return nil
}

// verifySignedPayload is the shared body of both public entry points. Keeping one
// implementation means a rule fixed for one attestation kind is fixed for the other. The
// signing input is computed only once the scheme and the signature length have been checked.
func verifySignedPayload(signingInput func() ([]byte, error), chainID, servedAddress, signatureHex string, scheme VerdictSignatureScheme) error {
	want, ok := VerdictSchemeForChain(chainID)
	if !ok {
		return fmt.Errorf("chain %q has no signature scheme", chainID)
	}
	if scheme != want {
		return fmt.Errorf("scheme %q does not match chain %q, which requires %q", scheme, chainID, want)
	}
	if n, ok := VerdictSignatureHexLen(scheme); !ok || len(signatureHex) != n {
		return fmt.Errorf("signature is %d hex characters, want %d for scheme %q", len(signatureHex), n, scheme)
	}

	digest, err := signingInput()
	if err != nil {
		return err
	}

	switch scheme {
	case VerdictSignatureSchemeEip712Secp256k1:
		served, err := decodeServedEvmAddress(servedAddress)
		if err != nil {
			return err
		}
		recovered, err := recoverSecp256k1(digest, signatureHex)
		if err != nil {
			return err
		}
		// Compare BYTES and not strings, so no case convention can make a mismatch look equal.
		if subtle.ConstantTimeCompare(recovered, served) != 1 {
			return fmt.Errorf("signature recovers to 0x%x, not to the served address", recovered)
		}
	case VerdictSignatureSchemeTip191Secp256k1:
		served, err := decodeServedTronAddress(servedAddress)
		if err != nil {
			return err
		}
		recovered, err := recoverSecp256k1(digest, signatureHex)
		if err != nil {
			return err
		}
		if subtle.ConstantTimeCompare(recovered, served) != 1 {
			return fmt.Errorf("signature recovers to an account other than the served address")
		}
	case VerdictSignatureSchemeEd25519Raw:
		pub, err := decodeServedEd25519Key(servedAddress)
		if err != nil {
			return err
		}
		if err := verifyEd25519(pub, digest, signatureHex); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unrecognised signature scheme %q", scheme)
	}
	return nil
}

// VerifyVerdictSignature completes the cryptographic half of the verification recipe for a
// fulfillment verdict: it derives the typed data or preimage the scheme signs, applies the
// scheme's digest rule, and checks the signature against the address the service published for
// the verdict's chain.
//
// It does NOT perform the binding steps or the domain check. Those need the question the caller
// asked and the payment it holds: use VerdictBindsTo, and compare `domain` against the value
// derived from the payment's verifier endpoint. A caller that only calls this has verified that
// SOME verdict was signed by the right key, not that THIS verdict answers its question.
func VerifyVerdictSignature(v *FulfillmentVerdict, servedAddress string) error {
	if v == nil {
		return fmt.Errorf("verdict is nil")
	}
	signingInput := func() ([]byte, error) { return verdictSigningInput(v) }
	return verifySignedPayload(signingInput, v.ChainId, servedAddress, v.Signature, v.SignatureScheme)
}

// VerifyDepositVerdictSignature is the same for a deposit verdict, against the payment's
// fulfillment_verifier.account, the escrow releaser on its SOURCE chain. The two kinds differ
// in their EIP-712 primary type and in their preimage tag, so a signature over one cannot
// satisfy this.
func VerifyDepositVerdictSignature(v *DepositVerdict, servedAddress string) error {
	if v == nil {
		return fmt.Errorf("deposit verdict is nil")
	}
	signingInput := func() ([]byte, error) { return depositVerdictSigningInput(v) }
	return verifySignedPayload(signingInput, v.ChainId, servedAddress, v.Signature, v.SignatureScheme)
}
