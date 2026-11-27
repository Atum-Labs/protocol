package lddataintegrity

import (
	"crypto/ed25519"
	"fmt"

	"github.com/mr-tron/base58"
)

// multibaseBase58btcPrefix is the multibase prefix byte ('z') for the
// base58btc encoding. W3C Ed25519Signature2020 multibase proofValue
// format: 'z' + base58btc(signature_bytes). See
// https://w3id.org/security/suites/ed25519-2020/v1 + the multibase RFC
// draft.
const multibaseBase58btcPrefix = "z"

// EncodeEd25519ProofValue produces the W3C multibase z-base58btc-encoded
// proofValue string from a 64-byte ed25519 signature. Used by the
// Ed25519Signature2020 cryptosuite as the inverse of
// DecodeEd25519ProofValue.
//
// Returns an error only if the signature is not exactly 64 bytes — a
// defensive caller-error check since ed25519.Sign always returns 64-
// byte output.
func EncodeEd25519ProofValue(signature []byte) (string, error) {
	if len(signature) != ed25519.SignatureSize {
		return "", fmt.Errorf("%w: ed25519 signature must be %d bytes, got %d",
			ErrMalformedProof, ed25519.SignatureSize, len(signature))
	}
	return multibaseBase58btcPrefix + base58.Encode(signature), nil
}

// DecodeEd25519ProofValue parses a W3C multibase z-base58btc-encoded
// proofValue string and returns the 64-byte ed25519 signature.
// Enforces the multibase prefix + length invariants — failures wrap
// ErrMalformedProof.
func DecodeEd25519ProofValue(proofValue string) ([]byte, error) {
	if len(proofValue) == 0 || proofValue[0:1] != multibaseBase58btcPrefix {
		return nil, fmt.Errorf("%w: proofValue must be z-base58btc multibase (start with 'z')", ErrMalformedProof)
	}
	signature, err := base58.Decode(proofValue[1:])
	if err != nil {
		return nil, fmt.Errorf("%w: decode base58btc: %v", ErrMalformedProof, err)
	}
	if len(signature) != ed25519.SignatureSize {
		return nil, fmt.Errorf("%w: decoded ed25519 signature must be %d bytes, got %d",
			ErrMalformedProof, ed25519.SignatureSize, len(signature))
	}
	return signature, nil
}

// SignEd25519 produces a 64-byte ed25519 signature over the given
// signing input. Thin wrapper around stdlib ed25519.Sign; exists so
// caller packages don't import crypto/ed25519 directly and so a future
// audit can add observability / key-policy hooks in a single place.
func SignEd25519(priv ed25519.PrivateKey, signingInput []byte) []byte {
	return ed25519.Sign(priv, signingInput)
}

// VerifyEd25519 returns nil if the signature verifies, else
// ErrEd25519Verify. The boolean-returning stdlib function is wrapped
// here so the lib's verification taxonomy stays consistent (typed
// sentinel errors callers can classify via errors.Is).
//
// signingInput is the same combined-hash bytes the signer hashed —
// see HashDocument with cryptosuite=Ed25519Signature2020 for the
// canonical construction.
func VerifyEd25519(pub ed25519.PublicKey, signingInput, signature []byte) error {
	if !ed25519.Verify(pub, signingInput, signature) {
		return ErrEd25519Verify
	}
	return nil
}
