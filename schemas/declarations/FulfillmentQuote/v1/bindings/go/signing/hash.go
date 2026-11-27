package ldverification

import (
	"errors"
	"fmt"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// HashableProofOptions are the W3C Data Integrity proof fields that
// participate in canonicalization. proofValue / jws are excluded: they
// are computed FROM the signing input HashQuote returns.
//
// Context is the verbatim @context for the proof block. Leave nil to use
// the canonical IRI for the cryptosuite; verifiers pass the wire value
// so a non-canonical-but-equivalent signer doesn't produce hashes that
// silently diverge from the signed bytes.
//
// Challenge + Domain are VP-only (W3C VC Data Model v1.1 §5.6)
// and stay optional so existing FulfillmentQuote callers are unaffected.
// When set together with ProofPurpose: "authentication", they participate
// in the proof canonicalization for VerifiablePresentation verification.
type HashableProofOptions struct {
	Type               string
	Created            string
	VerificationMethod string
	ProofPurpose       string
	Context            any
	Challenge          string
	Domain             string
}

// HashQuoteOptions configure HashQuote's canonicalization.
//
// KeepVerifiableCredential is VP-specific. FQ callers leave it
// false (default): the VC array is stripped defensively to keep a
// stale-proof carryover during re-signing from leaking into canonical
// bytes. VP envelope callers set it true: the VC array IS the signed
// payload (the holder is attesting to that bag of credentials), so
// stripping would leave the verifier reconstructing a hash over an empty
// `verifiableCredential` and rejecting every legitimate VP.
type HashQuoteOptions struct {
	Cryptosuite              string
	ProofOptions             HashableProofOptions
	KeepVerifiableCredential bool

	// Loader optionally overrides the process-global fqLoader for this
	// single canonicalization. Nil uses fqLoader (the default — FQ + FQE
	// contexts only). VP-envelope verifiers reconstructing a hash over an
	// envelope whose top-level @context is a DIFFERENT declaration (e.g.
	// PaymentRequestEnvelope) overlay that declaration's context onto
	// fqLoader via fqLoader.WithExtraContexts(...) and pass the result
	// here. Keeping this an override (not a registration on fqLoader)
	// preserves the settler/originator layering boundary: FQ's global
	// loader never learns about originator-side schemas.
	Loader *lddataintegrity.DocumentLoader
}

// HashResult exposes the bytes a signer signs (SigningInput) plus the
// intermediate document- and proof-options-hashes for audit / debug
// (and for pinning cross-language fixture parity with the TS twin).
//
// Alias of the shared lib's [lddataintegrity.HashResult] so callers
// holding the struct (test fixtures, conformance harness) keep
// compiling unchanged after the refactor.
type HashResult = lddataintegrity.HashResult

const (
	fulfillmentQuoteContextURL         = "https://schemas.atum.network/declarations/FulfillmentQuote/v1/context.jsonld"
	fulfillmentQuoteEnvelopeContextURL = "https://schemas.atum.network/declarations/FulfillmentQuoteEnvelope/v1/context.jsonld"
	w3cVCV1ContextURL                  = lddataintegrity.W3CVCV1ContextURL
	secp256k1Recovery2020V2CtxURL      = lddataintegrity.Secp256k1Recovery2020V2CtxURL
	ed25519Signature2020V1CtxURL       = lddataintegrity.Ed25519Signature2020V1CtxURL
)

// Exported context-URL constants for VP envelope callers (e.g. VerifyVP).
// The lowercase forms above stay package-private to keep the FQ-side
// wiring readable.
const (
	FulfillmentQuoteEnvelopeContextURL = fulfillmentQuoteEnvelopeContextURL
	W3CVCV1ContextURL                  = w3cVCV1ContextURL
)

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

// HashQuote computes the W3C Data Integrity signing input for a
// FulfillmentQuote under the given cryptosuite. The byte-for-byte twin
// of the TS hash.ts hashQuote function; both sides MUST stay in lock-step
// or the cross-language round trip silently breaks.
//
// Thin wrapper over [lddataintegrity.HashDocument]. The
// FQ-specific behavior preserved here:
//   - DefaultDocContext is the FQ-canonical [fulfillmentQuoteContextURL,
//     suiteCtx] pair; the lib injects it only when the caller-supplied
//     doc has no @context.
//   - KeepVerifiableCredential maps to the lib's
//     StripVerifiableCredential (negated semantics — FQ defaults to
//     STRIP, VP-envelope callers OPT IN to keep).
//   - The unsupported-cryptosuite + typo-mismatch guards stay FQ-local
//     and wrap FQ's own [ErrUnsupportedProofType] / [ErrMalformedProof]
//     so external dependents that classify failures via
//     `errors.Is(err, ldverification.Err…)` keep working unchanged.
//     The lib has equivalent sentinels under
//     its own taxonomy, but they're distinct values from FQ's.
//   - A document the lib refuses before canonicalizing (matching the
//     lib's ErrNotCanonicalizable), cannot canonicalize at all (matching
//     ErrCanonicalizationFailed), or that names an unregistered @context
//     URL (matching ErrUnknownContext), is wrapped in FQ's ErrMalformedQuote,
//     keeping the lib's error in the chain. HashDocument
//     canonicalizes through the lib directly rather than through
//     [Canonicalize], so the translation has to happen here. Other
//     canonicalization errors keep only the lib's sentinels.
func HashQuote(doc map[string]any, opts HashQuoteOptions) (HashResult, error) {
	suiteCtx := suiteContextURL(opts.Cryptosuite)
	if suiteCtx == "" {
		return HashResult{}, fmt.Errorf("HashQuote: unsupported cryptosuite %q: %w",
			opts.Cryptosuite, ErrUnsupportedProofType)
	}
	if opts.ProofOptions.Type != opts.Cryptosuite {
		// Cheap typo guard. A mismatched type/cryptosuite would
		// canonicalize the proof block under the wrong IRI and produce
		// a signing input no verifier on the network would reconstruct.
		// Kept FQ-side so the error wraps FQ's ErrMalformedProof rather
		// than the lib's (distinct sentinel, different errors.Is path).
		return HashResult{}, fmt.Errorf("HashQuote: ProofOptions.Type (%q) must match Cryptosuite (%q): %w",
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
		DefaultDocContext:         []any{fulfillmentQuoteContextURL, suiteCtx},
		StripVerifiableCredential: !opts.KeepVerifiableCredential,
	}

	// Loader override: VP-envelope verifiers reconstructing a
	// hash over a non-FQ envelope declaration pass a loader that overlays
	// the envelope context onto fqLoader. All other callers leave it nil
	// and get the process-global fqLoader (FQ + FQE contexts).
	loader := opts.Loader
	if loader == nil {
		loader = fqLoader
	}
	res, err := lddataintegrity.HashDocument(doc, libOpts, loader)
	if errors.Is(err, lddataintegrity.ErrNotCanonicalizable) ||
		errors.Is(err, lddataintegrity.ErrCanonicalizationFailed) ||
		errors.Is(err, lddataintegrity.ErrUnknownContext) {
		return HashResult{}, fmt.Errorf("%w: %w", ErrMalformedQuote, err)
	}
	return res, err
}
