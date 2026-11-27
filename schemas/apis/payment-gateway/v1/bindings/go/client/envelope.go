package pgclient

import (
	presigning "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequestEnvelope/v1/bindings/go/signing"
)

// EnvelopeOptions are the inputs to BuildEnvelope and SignInnerPaymentRequest.
//
// Aliased rather than redeclared so that a value built here is the same value the envelope
// package consumes: a struct copy would need field-by-field mapping, and a field added
// upstream would be silently dropped on the way through.
type EnvelopeOptions = presigning.Options

// BuildEnvelope wraps the originator's issuer-signed credentials in a holder-signed
// PaymentRequestEnvelope and returns the envelope JSON. This is the third of the three
// signatures a PaymentRequest carries, and the one that says WHO the originator is; see
// SignSenderAuth for the transfer authorization and SignDeclaration for the document proof.
//
// It signs only the envelope. The inner PaymentRequest is a separate artifact — see
// SignInnerPaymentRequest — and the verifier checks the two independently, asserting the
// inner signer is this envelope's holder.
//
// The credential bag and the signing key are both supplied by the caller. Note that the
// envelope requires at least one credential and the verifier rejects an empty bag, so this
// is only usable by an originator that actually holds credentials about itself.
func BuildEnvelope(opts EnvelopeOptions) ([]byte, error) {
	return presigning.BuildEnvelope(opts)
}

// SignInnerPaymentRequest signs the inner PaymentRequest with the same holder identity
// BuildEnvelope uses, so the inner signer and the envelope holder are the same did:pkh.
//
// This is the same signature SignDeclaration produces. Use this one when building an
// envelope, because it derives the verificationMethod from the holder's chain and address
// rather than asking for it separately, which is what keeps the two artifacts consistent.
func SignInnerPaymentRequest(opts EnvelopeOptions) ([]byte, error) {
	return presigning.SignInnerPaymentRequest(opts)
}
