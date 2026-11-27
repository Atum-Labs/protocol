package lddataintegrity

import (
	"bytes"
	"crypto/sha256"
	"fmt"

	"github.com/ethereum/go-ethereum/crypto"
)

// Supported cryptosuite identifiers per W3C Data Integrity 1.0.
const (
	CryptosuiteSecp256k1Recovery2020 = "EcdsaSecp256k1RecoverySignature2020"
	CryptosuiteEd25519Signature2020  = "Ed25519Signature2020"
)

// ProofOptions are the W3C Data Integrity proof fields that participate
// in canonicalization. proofValue / jws are excluded by design — they
// are computed FROM the signing input HashDocument returns, not part of
// the pre-hash inputs.
//
// Context is the verbatim @context for the proof block. Leave nil to
// use the canonical IRI for the cryptosuite; verifiers pass the wire
// value so a non-canonical-but-equivalent signer doesn't produce
// hashes that silently diverge from the signed bytes.
//
// Challenge + Domain are VP-only (W3C VC Data Model v1.1 §5.6) and
// stay optional so existing FulfillmentQuote callers are unaffected.
// When set together with ProofPurpose: "authentication", they
// participate in the proof canonicalization for VerifiablePresentation
// verification.
type ProofOptions struct {
	Type               string
	Created            string
	VerificationMethod string
	ProofPurpose       string
	Context            any
	Challenge          string
	Domain             string
}

// HashOptions configure HashDocument's canonicalization.
//
// Cryptosuite is required — selects the hash algorithm (Keccak256 for
// secp256k1, SHA-256 for ed25519) and the canonical proof-block
// @context IRI when ProofOptions.Context is nil.
//
// DefaultDocContext is the @context array to inject when the
// caller-supplied document doesn't already have one. Schema-specific
// callers pass their declaration's context URL (e.g. the
// FulfillmentQuote/v1/context.jsonld URL); a verifier reconstructing
// the hash from wire bytes uses the verbatim @context from the document
// and doesn't fall through to this default. Empty means "if the
// document has no @context, canonicalize without injecting one" —
// useful for tests; not what production signers want.
//
// StripVerifiableCredential controls whether to strip the
// verifiableCredential array from the document before canonicalization:
//   - false (default): KEEP the array. VP-envelope callers use this
//     because the VC array IS the signed payload (the holder is
//     attesting to that bag of credentials); stripping would leave
//     the verifier reconstructing a hash over an empty
//     `verifiableCredential` and rejecting every legitimate VP.
//   - true: STRIP the array. FQ-mode defensive strip; protects against
//     a stale-proof carryover during re-signing leaking into canonical
//     bytes when the document isn't a VP.
//
// The `proof` block is ALWAYS stripped — that's the load-bearing
// invariant of the W3C Data Integrity flow (the proof is what you're
// computing; it can't be input to its own computation).
type HashOptions struct {
	Cryptosuite               string
	ProofOptions              ProofOptions
	DefaultDocContext         any
	StripVerifiableCredential bool
}

// HashResult exposes the bytes a signer signs (SigningInput; secp256k1 settlers sign
// SettlerProof{ProofHash, DocHash} instead) plus the
// intermediate document- and proof-options-hashes for audit / debug
// (and for pinning cross-language fixture parity with the TS twin).
type HashResult struct {
	SigningInput []byte
	Cryptosuite  string
	DocHash      []byte
	ProofHash    []byte
}

// suiteContextURL returns the canonical proof-block @context IRI for a
// supported cryptosuite. Empty string for unsupported cryptosuite —
// the caller's dispatch picks that up as an error.
func suiteContextURL(cryptosuite string) string {
	switch cryptosuite {
	case CryptosuiteSecp256k1Recovery2020:
		return Secp256k1Recovery2020V2CtxURL
	case CryptosuiteEd25519Signature2020:
		return Ed25519Signature2020V1CtxURL
	default:
		return ""
	}
}

// HashDocument computes the W3C Data Integrity signing input for the
// given JSON-LD document under the given cryptosuite. The byte-for-byte
// twin of the TS hash.ts hashQuote function (and the FQ Go HashQuote it
// replaces) — both sides MUST stay in lock-step or the cross-language
// round trip silently breaks.
//
// Cryptosuite-specific composition:
//
//	EcdsaSecp256k1RecoverySignature2020:
//	  SigningInput = keccak256(proofHash || docHash)
//	  per-hash     = keccak256(canonical n-quads)
//
//	Ed25519Signature2020:
//	  SigningInput = proofHash || docHash   (raw 64-byte concat)
//	  per-hash     = SHA-256(canonical n-quads)
//
// Input rules:
//   - doc MUST have its proof block stripped by the caller. HashDocument
//     ALSO strips proof defensively so a stale carryover (re-sign,
//     partial parse) can't bleed into the canonical bytes.
//   - doc["verifiableCredential"] is stripped only when
//     StripVerifiableCredential is true (FQ mode). VP-envelope callers
//     leave it false so the VC array participates in canonicalization.
//   - doc["@context"] is preserved verbatim if present; otherwise
//     opts.DefaultDocContext is injected (or omitted if nil).
//
// loader is the strict-no-network document loader to use for
// URDNA2015 canonicalization (see NewDocumentLoader). Required —
// nil triggers Canonicalize's defensive nil-loader guard.
func HashDocument(doc map[string]any, opts HashOptions, loader *DocumentLoader) (HashResult, error) {
	suiteCtx := suiteContextURL(opts.Cryptosuite)
	if suiteCtx == "" {
		return HashResult{}, fmt.Errorf("%w: %q", ErrUnsupportedProofType, opts.Cryptosuite)
	}
	if opts.ProofOptions.Type != opts.Cryptosuite {
		// Cheap typo guard. A mismatched type/cryptosuite would
		// canonicalize the proof block under the wrong IRI and produce
		// a signing input no verifier on the network would reconstruct.
		return HashResult{}, fmt.Errorf("%w: ProofOptions.Type (%q) must match Cryptosuite (%q)",
			ErrMalformedProof, opts.ProofOptions.Type, opts.Cryptosuite)
	}

	bareDoc := make(map[string]any, len(doc))
	for k, v := range doc {
		if k == "proof" {
			// Always strip the proof block; load-bearing — see hash.ts.
			continue
		}
		if k == "verifiableCredential" && opts.StripVerifiableCredential {
			continue
		}
		bareDoc[k] = v
	}
	if _, hasCtx := bareDoc["@context"]; !hasCtx && opts.DefaultDocContext != nil {
		bareDoc["@context"] = opts.DefaultDocContext
	}

	proofContext := opts.ProofOptions.Context
	if proofContext == nil {
		proofContext = suiteCtx
	}
	proofWithContext := map[string]any{
		"@context":           proofContext,
		"type":               opts.ProofOptions.Type,
		"created":            opts.ProofOptions.Created,
		"verificationMethod": opts.ProofOptions.VerificationMethod,
		"proofPurpose":       opts.ProofOptions.ProofPurpose,
	}
	// VP-only fields. Added unconditionally when set so canonical
	// n-quads include them; FQ callers leave them empty and the block
	// canonicalizes identically to pre-VP behavior.
	if opts.ProofOptions.Challenge != "" {
		proofWithContext["challenge"] = opts.ProofOptions.Challenge
	}
	if opts.ProofOptions.Domain != "" {
		proofWithContext["domain"] = opts.ProofOptions.Domain
	}

	canonicalDoc, err := Canonicalize(bareDoc, loader)
	if err != nil {
		return HashResult{}, fmt.Errorf("HashDocument: canonicalize document: %w", err)
	}
	canonicalProof, err := Canonicalize(proofWithContext, loader)
	if err != nil {
		return HashResult{}, fmt.Errorf("HashDocument: canonicalize proof options: %w", err)
	}

	switch opts.Cryptosuite {
	case CryptosuiteSecp256k1Recovery2020:
		docHash := crypto.Keccak256([]byte(canonicalDoc))
		proofHash := crypto.Keccak256([]byte(canonicalProof))
		signingInput := crypto.Keccak256(bytes.Join([][]byte{proofHash, docHash}, nil))
		return HashResult{
			SigningInput: signingInput,
			Cryptosuite:  opts.Cryptosuite,
			DocHash:      docHash,
			ProofHash:    proofHash,
		}, nil
	case CryptosuiteEd25519Signature2020:
		docSum := sha256.Sum256([]byte(canonicalDoc))
		proofSum := sha256.Sum256([]byte(canonicalProof))
		docHash := docSum[:]
		proofHash := proofSum[:]
		signingInput := make([]byte, 0, len(proofHash)+len(docHash))
		signingInput = append(signingInput, proofHash...)
		signingInput = append(signingInput, docHash...)
		return HashResult{
			SigningInput: signingInput,
			Cryptosuite:  opts.Cryptosuite,
			DocHash:      docHash,
			ProofHash:    proofHash,
		}, nil
	default:
		// Unreachable: suiteContextURL already gated the dispatch.
		return HashResult{}, fmt.Errorf("HashDocument: cryptosuite dispatch fell through for %q", opts.Cryptosuite)
	}
}
