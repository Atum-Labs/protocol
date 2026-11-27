package lddataintegrity

import (
	"crypto/ecdsa"
	"errors"

	"github.com/ethereum/go-ethereum/crypto"
)

// Secp256k1Signer abstracts "sign a 32-byte digest" so the W3C Data
// Integrity sign functions can be backed EITHER by a raw in-process
// *ecdsa.PrivateKey (dev / encrypted-storage custody) OR by a remote KMS,
// without the shared signing lib depending on any KMS SDK.
//
// Output contract (STRICT — the sign functions rely on it):
//   - SignDigest returns a 65-byte signature r||s||v with v ∈ {0,1} and s
//     low-s normalized (EIP-2 canonical). This is exactly what
//     crypto.Sign returns and what Secp256k1ESRecoveryFromDER produces.
//     The +27 EIP-191 wire alignment is applied ONCE by the caller (the
//     sign function), so an implementation MUST NOT pre-add it.
//   - The digest is the final 32-byte hash to sign as-is. Implementations
//     MUST NOT re-hash it (a KMS "sign message" mode that SHA-256s the
//     input produces a signature no verifier recovers — use the KMS
//     "sign digest" mode instead).
//
// PublicKeyUncompressed returns the 65-byte uncompressed public key
// (0x04||X||Y). KMS implementations use it as the expectedPub for the
// recovery-id search. It is ALSO the key any remote-KMS caller MUST derive
// the holder address from — otherwise the attested holder can diverge from
// the signing key. (The dev/local path derives the address from the same
// *ecdsa.PrivateKey it wraps, so they can't diverge there; a remote-KMS
// wiring has no such shared key and must go through this method.)
type Secp256k1Signer interface {
	SignDigest(digest []byte) ([]byte, error)
	PublicKeyUncompressed() []byte
}

// ecdsaKeySigner adapts a raw in-process *ecdsa.PrivateKey to
// Secp256k1Signer. It is byte-for-byte equivalent to calling crypto.Sign
// directly, so wrapping the existing raw-key sign path in it is a no-op on
// the wire (the behavior-preserving default for dev / encrypted-storage).
type ecdsaKeySigner struct{ priv *ecdsa.PrivateKey }

// NewECDSASigner wraps a raw secp256k1 private key as a Secp256k1Signer.
// Returns an error on a nil key so callers fail closed rather than
// panicking inside SignDigest.
func NewECDSASigner(priv *ecdsa.PrivateKey) (Secp256k1Signer, error) {
	if priv == nil {
		return nil, errors.New("lddataintegrity: nil private key")
	}
	return ecdsaKeySigner{priv: priv}, nil
}

func (s ecdsaKeySigner) SignDigest(digest []byte) ([]byte, error) {
	// crypto.Sign returns 65-byte r||s||v with v ∈ {0,1}, low-s normalized —
	// exactly the Secp256k1Signer output contract.
	return crypto.Sign(digest, s.priv)
}

func (s ecdsaKeySigner) PublicKeyUncompressed() []byte {
	return crypto.FromECDSAPub(&s.priv.PublicKey)
}
