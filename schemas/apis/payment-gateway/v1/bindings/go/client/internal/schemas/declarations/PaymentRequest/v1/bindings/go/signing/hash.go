package ldverification

import (
	"errors"
	"fmt"

	lddataintegrity "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/common/ld-data-integrity/go"
)

// HashableProofOptions are the W3C Data Integrity proof fields that
// participate in canonicalization. proofValue / jws are excluded: they
// are computed FROM the signing input HashPaymentRequest returns.
//
// Context is the verbatim @context for the proof block. Leave nil to use
// the canonical IRI for the cryptosuite; verifiers pass the wire value
// so a non-canonical-but-equivalent signer doesn't produce hashes that
// silently diverge from the signed bytes.
//
// Challenge + Domain are carried for shape-parity with the FQ
// HashableProofOptions (W3C VC Data Model v1.1 §5.6, VP-only). The inner
// PaymentRequest is an assertion, not a presentation, so PaymentRequest
// signers leave them empty — they're here only so a future
// PaymentRequestEnvelope (PRE) verifier can reuse the
// same struct without a divergent field set.
type HashableProofOptions struct {
	Type               string
	Created            string
	VerificationMethod string
	ProofPurpose       string
	Context            any
	Challenge          string
	Domain             string
}

// HashPaymentRequestOptions configure HashPaymentRequest's
// canonicalization.
//
// KeepVerifiableCredential mirrors the FQ option's negated semantics
// against the lib's StripVerifiableCredential. The inner PaymentRequest
// is NOT a VP, so PaymentRequest callers leave it false (the default):
// any verifiableCredential array is defensively stripped so a stale
// carryover during re-signing can't leak into canonical bytes. Kept on
// the struct for parity with FQ + the PRE envelope path.
type HashPaymentRequestOptions struct {
	Cryptosuite              string
	ProofOptions             HashableProofOptions
	KeepVerifiableCredential bool
}

// HashResult exposes the bytes a signer signs (SigningInput) plus the
// intermediate document- and proof-options-hashes for audit / debug
// (and for pinning cross-language fixture parity with the TS twin in
// schemas/.../typescript/ld-signing/src/hash.ts).
//
// Alias of the shared lib's [lddataintegrity.HashResult] so callers
// holding the struct (test fixtures, conformance harness) keep
// compiling unchanged.
type HashResult = lddataintegrity.HashResult

const (
	paymentRequestContextURL      = "https://schemas.atum.network/declarations/PaymentRequest/v1/context.jsonld"
	secp256k1Recovery2020V2CtxURL = lddataintegrity.Secp256k1Recovery2020V2CtxURL
	ed25519Signature2020V1CtxURL  = lddataintegrity.Ed25519Signature2020V1CtxURL
)

// PaymentRequestContextURL is the exported PaymentRequest @context IRI
// for downstream callers (e.g. the PaymentRequestEnvelope verifier).
// The lowercase form above stays package-private to
// keep the PR-side wiring readable.
const PaymentRequestContextURL = paymentRequestContextURL

// suiteContextURL returns the canonical proof-block @context IRI for a
// supported cryptosuite. Empty string for an unsupported cryptosuite —
// the caller's switch picks that up as an error.
func suiteContextURL(cryptosuite string) string {
	switch cryptosuite {
	case ProofTypeSecp256k1Recovery2020:
		return secp256k1Recovery2020V2CtxURL
	case ProofTypeEd25519Signature2020:
		return ed25519Signature2020V1CtxURL
	default:
		return ""
	}
}

// HashPaymentRequest computes the W3C Data Integrity signing input for a
// PaymentRequest under the given cryptosuite. The byte-for-byte twin of
// the TS hash.ts hashPaymentRequest function; both sides MUST stay in
// lock-step or the cross-language round trip silently breaks.
//
// Thin wrapper over [lddataintegrity.HashDocument]. The
// PaymentRequest-specific behavior preserved here:
//   - DefaultDocContext is the PR-canonical [paymentRequestContextURL,
//     suiteCtx] pair; the lib injects it only when the caller-supplied
//     doc has no @context.
//   - KeepVerifiableCredential maps to the lib's
//     StripVerifiableCredential (negated semantics — PR defaults to
//     STRIP, matching FQ).
//   - The unsupported-cryptosuite + typo-mismatch guards stay PR-local
//     and wrap PR's own [ErrUnsupportedProofType] / [ErrMalformedProof]
//     so dependents that classify failures via
//     `errors.Is(err, ldverification.Err…)` get the PR taxonomy. The lib
//     has equivalent sentinels under its own taxonomy, but they're
//     distinct values.
//   - A document the lib refuses before canonicalizing (matching the
//     lib's ErrNotCanonicalizable), cannot canonicalize at all (matching
//     ErrCanonicalizationFailed), or that names an unregistered @context
//     URL (matching ErrUnknownContext), is wrapped in PR's ErrMalformedRequest,
//     keeping the lib's error in the chain. HashDocument
//     canonicalizes through the lib directly rather than through
//     [Canonicalize], so the translation has to happen here. Other
//     canonicalization errors keep only the lib's sentinels.
func HashPaymentRequest(doc map[string]any, opts HashPaymentRequestOptions) (HashResult, error) {
	suiteCtx := suiteContextURL(opts.Cryptosuite)
	if suiteCtx == "" {
		return HashResult{}, fmt.Errorf("HashPaymentRequest: unsupported cryptosuite %q: %w",
			opts.Cryptosuite, ErrUnsupportedProofType)
	}
	if opts.ProofOptions.Type != opts.Cryptosuite {
		// Cheap typo guard. A mismatched type/cryptosuite would
		// canonicalize the proof block under the wrong IRI and produce
		// a signing input no verifier on the network would reconstruct.
		// Kept PR-side so the error wraps PR's ErrMalformedProof rather
		// than the lib's (distinct sentinel, different errors.Is path).
		return HashResult{}, fmt.Errorf("HashPaymentRequest: ProofOptions.Type (%q) must match Cryptosuite (%q): %w",
			opts.ProofOptions.Type, opts.Cryptosuite, ErrMalformedProof)
	}

	libOpts := lddataintegrity.HashOptions{
		Cryptosuite: opts.Cryptosuite,
		ProofOptions: lddataintegrity.ProofOptions{
			Type:               opts.ProofOptions.Type,
			Created:            opts.ProofOptions.Created,
			VerificationMethod: opts.ProofOptions.VerificationMethod,
			ProofPurpose:       opts.ProofOptions.ProofPurpose,
			Context:            opts.ProofOptions.Context,
			Challenge:          opts.ProofOptions.Challenge,
			Domain:             opts.ProofOptions.Domain,
		},
		DefaultDocContext:         []any{paymentRequestContextURL, suiteCtx},
		StripVerifiableCredential: !opts.KeepVerifiableCredential,
	}

	res, err := lddataintegrity.HashDocument(doc, libOpts, prLoader)
	if errors.Is(err, lddataintegrity.ErrNotCanonicalizable) ||
		errors.Is(err, lddataintegrity.ErrCanonicalizationFailed) ||
		errors.Is(err, lddataintegrity.ErrUnknownContext) {
		return HashResult{}, fmt.Errorf("%w: %w", ErrMalformedRequest, err)
	}
	return res, err
}
