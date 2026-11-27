package ldverification

import (
	"errors"
	"fmt"
)

// ErrMalformedProof is the umbrella sentinel for every "the caller's
// PaymentRequest is the wrong shape" error returned by
// VerifyPaymentRequest. Callers that need to dispatch malformed-request
// (HTTP 400) vs auth-failure (HTTP 401) can use a single
// errors.Is(err, ErrMalformedProof) check; the more specific sentinels
// below are wrap targets for finer-grained logging or client-facing
// error codes.
//
// Mirror of the FulfillmentQuote ld-verification taxonomy
// (schemas/declarations/FulfillmentQuote/v1/bindings/go/signing/errors.go) —
// kept structurally identical so a service that already classifies FQ
// verification failures via errors.Is can reuse the same code path for
// PaymentRequest with no new sentinel-mapping logic.
//
// Errors that mean "the bytes don't authenticate" (recovery failures,
// canonicalization-then-mismatch failures, ed25519.Verify returning
// false) deliberately do NOT wrap any of these — they're auth-class and
// must stay 401.
var ErrMalformedProof = errors.New("malformed proof")

var (
	// ErrMissingProof: the PaymentRequest has no proof block at all.
	ErrMissingProof = fmt.Errorf("%w: missing proof", ErrMalformedProof)

	// ErrUnsupportedProofType: proof.type is not a cryptosuite this
	// verifier accepts, or proof.proofPurpose is not assertionMethod.
	ErrUnsupportedProofType = fmt.Errorf("%w: unsupported proof type", ErrMalformedProof)

	// ErrMissingSignatureMaterial: the proof carries no signature bytes
	// — proof.jws empty (secp256k1 path) or proof.proofValue empty
	// (ed25519 path).
	ErrMissingSignatureMaterial = fmt.Errorf("%w: missing signature material", ErrMalformedProof)

	// ErrMalformedSignatureMaterial: the signature bytes were present
	// but structurally invalid — JWS envelope unparseable, multibase
	// prefix wrong, ed25519 signature length wrong, base58 decode
	// failure, etc. Distinct from ErrMissingSignatureMaterial because
	// the caller intended to provide a signature but mangled the
	// encoding.
	ErrMalformedSignatureMaterial = fmt.Errorf("%w: malformed signature material", ErrMalformedProof)

	// ErrMalformedRequest: top-level document parse failure, or
	// verificationMethod / @context shape errors that prevent
	// canonicalization from running. These are document-level, not
	// signature-level. (FQ names its equivalent ErrMalformedQuote; the
	// PaymentRequest noun is "Request".)
	ErrMalformedRequest = fmt.Errorf("%w: malformed payment request", ErrMalformedProof)
)

// ErrSignerChainMismatch: a verified ed25519 signer's did:pkh namespace or
// network reference does not match the CAIP-2 chain the caller expected
// (SelfAssertedEd25519Signer.MatchesChain). It is an authorization refusal,
// not a malformed document, so it does not wrap ErrMalformedProof.
var ErrSignerChainMismatch = errors.New("signer chain mismatch")
