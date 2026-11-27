package lddataintegrity

import (
	"bytes"
	"encoding/asn1"
	"errors"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/crypto/secp256k1"
)

// secp256k1HalfN is N/2 of the secp256k1 group order. Signatures with
// s greater than this are "high-s"; EIP-2 and several signature
// verifiers downstream of us reject them as malleable. Cloud KMS
// backends (AWS KMS, GCP KMS) do not enforce low-s, so the
// secp256k1 recovery helper normalizes at the boundary.
var secp256k1HalfN = new(big.Int).Rsh(secp256k1.S256().Params().N, 1)

// secp256k1N is the secp256k1 group order, used to flip s when
// normalizing to low-s form.
var secp256k1N = secp256k1.S256().Params().N

// ecdsaSig matches the ASN.1 SEQUENCE { INTEGER, INTEGER } that cloud
// KMS backends (AWS KMS, GCP KMS) return from their Sign() endpoints
// for ECDSA keys.
type ecdsaSig struct {
	R, S *big.Int
}

// RecoverSecp256k1Signer recovers the signer's EVM address from a
// Keccak256 32-byte digest and a 65-byte ES256K-R signature (r||s||v).
// Used by W3C Data Integrity EcdsaSecp256k1RecoverySignature2020
// verification to derive the chain-canonical identity of the signer
// without holding the public key out of band.
//
// The v byte normalisation (subtracting 27 when v >= 27) accommodates
// the EIP-191 convention some signers use. The go-ethereum recovery
// path expects v in {0, 1} — the subtraction makes the function accept
// both forms transparently.
//
// Any other v is refused up front, as the TS sibling refuses it. Left to
// go-ethereum, the answer depended on the build: without cgo, SigToPub
// also recovered the signer from a v of 4, 5, 31 or 32.
//
// Failure modes:
//   - ErrMalformedProof when signature is not 65 bytes or hash is not
//     32 bytes (defensive caller-error check).
//   - ErrSignatureRecovery when v is not 0, 1, 27 or 28, when
//     go-ethereum's SigToPub returns an error (invalid recovery id,
//     malformed compact signature), OR when the signature is high-s
//     (non-canonical / malleable) — see below.
//
// High-s rejection: a valid ECDSA signature (r, s) has a malleable
// "twin" (r, N-s) that is equally valid for the same signer + digest.
// EIP-2 (and ethers' Signature.from, which the TS sibling
// recoverSecp256k1Signer relies on) reject the high-s form; go-ethereum's
// SigToPub recovers it happily. This function rejects high-s too so the
// shared Go/TS lib gives the SAME yes/no answer for the same bytes — our
// own signers always emit low-s (Secp256k1ESRecoveryFromDER normalises),
// so this only ever rejects an externally-supplied malleable twin.
func RecoverSecp256k1Signer(hash []byte, signature []byte) (common.Address, error) {
	if len(signature) != 65 {
		return common.Address{}, fmt.Errorf("%w: signature must be 65 bytes, got %d", ErrMalformedProof, len(signature))
	}
	if len(hash) != 32 {
		return common.Address{}, fmt.Errorf("%w: hash must be 32 bytes, got %d", ErrMalformedProof, len(hash))
	}

	switch signature[64] {
	case 0, 1, 27, 28:
	default:
		return common.Address{}, fmt.Errorf("%w: recovery byte v = %d, want 0, 1, 27 or 28", ErrSignatureRecovery, signature[64])
	}

	// Copy so the caller's slice isn't mutated by the v-byte normalisation.
	sig := make([]byte, 65)
	copy(sig, signature)
	if sig[64] >= 27 {
		sig[64] -= 27
	}

	// Reject high-s to match EIP-2 / the TS verifier (see docstring).
	if s := new(big.Int).SetBytes(sig[32:64]); s.Cmp(secp256k1HalfN) > 0 {
		return common.Address{}, fmt.Errorf("%w: signature has high-s (non-canonical / malleable); rejected to match EIP-2 and the TS verifier", ErrSignatureRecovery)
	}

	pubKey, err := crypto.SigToPub(hash, sig)
	if err != nil {
		return common.Address{}, fmt.Errorf("%w: %v", ErrSignatureRecovery, err)
	}

	return crypto.PubkeyToAddress(*pubKey), nil
}

// Secp256k1ESRecoveryFromDER converts an ASN.1 DER-encoded ECDSA
// signature (the format AWS / GCP KMS returns for secp256k1 keys)
// into a 65-byte ES256K-R signature suitable for the
// EcdsaSecp256k1RecoverySignature2020 cryptosuite (r||s||v with
// v ∈ {0,1}). Use [BuildSecp256k1JWS] on the result to wrap it
// into the wire-shape JWS the W3C verifier expects.
//
// Inputs:
//   - der: the ASN.1 DER bytes returned by the KMS backend.
//   - expectedPub: the uncompressed 65-byte public key (0x04 || X || Y)
//     of the signing key. Used to disambiguate which of the two
//     possible recovery candidates (v=0 vs v=1) is correct.
//   - digest: the 32-byte hash that was signed.
//
// Behavior:
//  1. Parses (r, s) from DER.
//  2. Normalizes to low-s form (EIP-2 / canonical ECDSA). Cloud KMS
//     backends pick whichever s they please; flip half the time so
//     downstream verifiers don't reject as malleable.
//  3. Tries v=0 then v=1 against crypto.Ecrecover; returns the 65-byte
//     sig whose recovered pubkey matches expectedPub byte-for-byte.
//
// Failure modes:
//   - ErrMalformedProof: der is empty / malformed, expectedPub wrong
//     shape, digest not 32 bytes.
//   - ErrSignatureRecovery: neither v=0 nor v=1 recovers expectedPub
//     (key/digest mismatch — caller passed the wrong key for the
//     signature, or the digest was computed from different bytes
//     than what the KMS actually signed).
//
// This is the load-bearing helper for KMS-backed W3C secp256k1recovery
// signing.
func Secp256k1ESRecoveryFromDER(der []byte, expectedPub []byte, digest []byte) ([]byte, error) {
	if len(digest) != 32 {
		return nil, fmt.Errorf("%w: digest must be 32 bytes, got %d", ErrMalformedProof, len(digest))
	}
	if len(expectedPub) != 65 || expectedPub[0] != 0x04 {
		return nil, fmt.Errorf("%w: expectedPub must be 65-byte uncompressed (0x04||X||Y), got len=%d", ErrMalformedProof, len(expectedPub))
	}

	r, s, err := parseDERSignature(der)
	if err != nil {
		return nil, fmt.Errorf("%w: parse DER: %v", ErrMalformedProof, err)
	}

	// Normalize to low-s. Without this, downstream Ethereum-flavored
	// verifiers (anything routed through go-ethereum's secp256k1 path)
	// flag the signature malleable and reject.
	if s.Cmp(secp256k1HalfN) > 0 {
		s = new(big.Int).Sub(secp256k1N, s)
	}

	rsCompact := make([]byte, 64)
	// Right-justify into fixed 32-byte slots so leading zeros from r
	// or s don't shift the layout. crypto.Ecrecover requires exactly
	// 65 bytes with the recovery byte at index 64.
	r.FillBytes(rsCompact[:32])
	s.FillBytes(rsCompact[32:])

	// Try v = 0 then v = 1. crypto.Ecrecover returns the uncompressed
	// 65-byte pubkey recovered with the supplied recovery byte; pick
	// the v that reproduces expectedPub exactly.
	for v := byte(0); v <= 1; v++ {
		sig := make([]byte, 65)
		copy(sig, rsCompact)
		sig[64] = v
		recovered, recErr := crypto.Ecrecover(digest, sig)
		if recErr != nil {
			continue
		}
		if bytes.Equal(recovered, expectedPub) {
			return sig, nil
		}
	}
	return nil, fmt.Errorf("%w: neither v=0 nor v=1 recovered the expected public key (digest/pubkey mismatch?)", ErrSignatureRecovery)
}

// parseDERSignature decodes the ASN.1 DER encoding cloud KMS backends
// return for ECDSA signatures into the component (r, s) integers.
// Short-form length encoding only — secp256k1 signatures always fit
// in short form. Long-form input is rejected explicitly so behavior
// matches the TS sibling implementation.
func parseDERSignature(der []byte) (*big.Int, *big.Int, error) {
	if len(der) >= 2 && der[1]&0x80 != 0 {
		return nil, nil, errors.New("DER long-form length not supported (secp256k1 sigs fit in short form)")
	}
	var sig ecdsaSig
	rest, err := asn1.Unmarshal(der, &sig)
	if err != nil {
		return nil, nil, fmt.Errorf("asn1.Unmarshal: %w", err)
	}
	if len(rest) != 0 {
		return nil, nil, fmt.Errorf("trailing %d bytes after DER signature", len(rest))
	}
	if sig.R == nil || sig.S == nil || sig.R.Sign() <= 0 || sig.S.Sign() <= 0 {
		return nil, nil, errors.New("invalid r or s in DER signature")
	}
	// Bound r, s into the valid ECDSA range [1, N-1]. Out-of-range
	// values would surface downstream as a "neither v recovers
	// expectedPub" error from the recovery search, which is the wrong
	// diagnostic — surface the parse-side reality instead so operators
	// can distinguish caller-error from key/digest-mismatch.
	if sig.R.Cmp(secp256k1N) >= 0 || sig.S.Cmp(secp256k1N) >= 0 {
		return nil, nil, errors.New("r or s out of range [1, N-1] for secp256k1")
	}
	return sig.R, sig.S, nil
}
