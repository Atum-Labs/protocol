package ldverification

// Public VC-proof signing helpers. The verifier-side VerifyVCProof
// (verify_vc.go) is the production crypto gate; this file exists so
// the conformance fixture generator and any future cross-package
// consumer can mint a signed VC byte-for-byte the way the issuer
// would, without copying the canonicalization recipe out of
// verify_vc_test.go.
//
// CONTRACT WITH ISSUER SIGNING: this is the verifier-package mirror
// of the issuer's proof-apply path. The canonicalization, hash
// composition, and signature recovery MUST stay in lockstep across
// both packages and both languages — divergence here would corrupt
// every signature the conformance fixtures pin.

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"errors"
	"fmt"

	lddataintegrity "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/crypto"
)

// SignVCProofSecp256k1WithCreatedString signs a VC body under the
// EcdsaSecp256k1RecoverySignature2020 cryptosuite. Returns the VC
// body with a `proof` block attached, ready to embed in a VP envelope
// or hand to VerifyVCProof.
//
// Inputs:
//   - vcBody — the VC payload WITHOUT a proof block (issuer-side input).
//     MUST carry its own `@context` (typically `["https://www.w3.org/2018/credentials/v1"]`
//     plus any issuer-specific credential context).
//   - priv — the issuer's secp256k1 signing key. Caller derives the
//     verificationMethod URL fragment from the same key (e.g.
//     `did:web:atumlabs.xyz#key-1`).
//   - verificationMethod — the full DID URL the proof block references.
//   - proofPurpose — typically `"assertionMethod"` for VC proofs.
//   - createdStr — verbatim timestamp; canonical W3C form is
//     "YYYY-MM-DDTHH:MM:SSZ". Pinned form keeps cross-language byte
//     equality intact.
//
// Returns the signed VC as a `map[string]any` (caller can json.Marshal).
// Mutates a copy of vcBody — original is unchanged.
func SignVCProofSecp256k1WithCreatedString(
	vcBody map[string]any,
	priv *ecdsa.PrivateKey,
	verificationMethod string,
	proofPurpose string,
	createdStr string,
) (map[string]any, error) {
	if priv == nil {
		return nil, errors.New("SignVCProofSecp256k1: nil private key")
	}
	if vcBody == nil {
		return nil, errors.New("SignVCProofSecp256k1: nil vc body")
	}
	if _, hasProof := vcBody["proof"]; hasProof {
		return nil, errors.New("SignVCProofSecp256k1: vc body already has a proof field; refusing to overwrite")
	}
	if verificationMethod == "" {
		return nil, errors.New("SignVCProofSecp256k1: verificationMethod is required")
	}

	suiteCtx := secp256k1Recovery2020V2CtxURL

	// HashQuote delegates canonicalize-then-hash to the shared data-integrity
	// library. vcBody MUST carry its own @context (issuer-side
	// invariant) so HashQuote's DefaultDocContext injection is a no-op
	// here. KeepVerifiableCredential=false matches FQ's defensive-strip
	// default — VC bodies never carry a nested `verifiableCredential`
	// field; the flag is a no-op for this shape too.
	hash, err := HashQuote(vcBody, HashQuoteOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeSecp256k1Recovery2020,
			Created:            createdStr,
			VerificationMethod: verificationMethod,
			ProofPurpose:       proofPurpose,
			Context:            suiteCtx,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("SignVCProofSecp256k1: HashQuote: %w", err)
	}

	sig, err := crypto.Sign(hash.SigningInput, priv)
	if err != nil {
		return nil, fmt.Errorf("SignVCProofSecp256k1: sign: %w", err)
	}
	// Match go-ethereum's recovery-id offset convention (ES256K-R):
	// align v from {0,1} to {27,28} so the JS-side verifiers in the
	// cross-language conformance suite recover the same address.
	sig[64] += 27

	jws, err := lddataintegrity.BuildSecp256k1JWS(sig)
	if err != nil {
		return nil, fmt.Errorf("SignVCProofSecp256k1: build JWS: %w", err)
	}

	out := cloneMapForVCSign(vcBody)
	out["proof"] = map[string]any{
		"@context":           suiteCtx,
		"type":               ProofTypeSecp256k1Recovery2020,
		"created":            createdStr,
		"verificationMethod": verificationMethod,
		"proofPurpose":       proofPurpose,
		"jws":                jws,
	}
	return out, nil
}

// SignVCProofEd25519WithCreatedString signs a VC body under the
// Ed25519Signature2020 cryptosuite. Same shape as the secp256k1
// counterpart; the only deltas are the hash composition (delegated
// to HashQuote's ed25519 branch) and the proofValue encoding
// (multibase-base58btc rather than detached JWS).
func SignVCProofEd25519WithCreatedString(
	vcBody map[string]any,
	priv ed25519.PrivateKey,
	verificationMethod string,
	proofPurpose string,
	createdStr string,
) (map[string]any, error) {
	if priv == nil {
		return nil, errors.New("SignVCProofEd25519: nil private key")
	}
	if vcBody == nil {
		return nil, errors.New("SignVCProofEd25519: nil vc body")
	}
	if _, hasProof := vcBody["proof"]; hasProof {
		return nil, errors.New("SignVCProofEd25519: vc body already has a proof field; refusing to overwrite")
	}
	if verificationMethod == "" {
		return nil, errors.New("SignVCProofEd25519: verificationMethod is required")
	}

	suiteCtx := ed25519Signature2020V1CtxURL

	hash, err := HashQuote(vcBody, HashQuoteOptions{
		Cryptosuite: ProofTypeEd25519Signature2020,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeEd25519Signature2020,
			Created:            createdStr,
			VerificationMethod: verificationMethod,
			ProofPurpose:       proofPurpose,
			Context:            suiteCtx,
		},
		KeepVerifiableCredential: false,
	})
	if err != nil {
		return nil, fmt.Errorf("SignVCProofEd25519: HashQuote: %w", err)
	}

	sig := ed25519.Sign(priv, hash.SigningInput)
	proofValue, err := lddataintegrity.EncodeEd25519ProofValue(sig)
	if err != nil {
		return nil, fmt.Errorf("SignVCProofEd25519: encode proofValue: %w", err)
	}

	out := cloneMapForVCSign(vcBody)
	out["proof"] = map[string]any{
		"@context":           suiteCtx,
		"type":               ProofTypeEd25519Signature2020,
		"created":            createdStr,
		"verificationMethod": verificationMethod,
		"proofPurpose":       proofPurpose,
		"proofValue":         proofValue,
	}
	return out, nil
}

func cloneMapForVCSign(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
