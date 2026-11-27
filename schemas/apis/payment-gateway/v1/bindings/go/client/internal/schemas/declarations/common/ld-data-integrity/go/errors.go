// Package lddataintegrity provides W3C Data Integrity 1.0 primitives
// (URDNA2015 canonicalization, JWS construction, signature recovery,
// Ed25519 sign/verify) factored out of the three previously-independent
// implementations in the Atum codebase. See README.md for the migration
// table.
package lddataintegrity

import "errors"

// Sentinel errors. Callers use errors.Is to classify failures into
// transport-level statuses (4xx for malformed input, 5xx for resolver
// failures, etc.) without re-classifying string errors. Mirror of a
// long-established sentinel-error pattern.

// ErrMalformedProof is returned when a proof block is structurally
// invalid (missing required field, wrong type, bad encoding). Maps to
// HTTP 400 / gRPC InvalidArgument at the transport layer.
var ErrMalformedProof = errors.New("malformed proof")

// ErrUnsupportedProofType is returned when the proof's `type` field is
// not one of the supported cryptosuites (EcdsaSecp256k1RecoverySignature2020,
// Ed25519Signature2020). Distinct from ErrMalformedProof because forward-
// compat may legitimately add cryptosuites; an unsupported type isn't
// necessarily an attacker signal.
var ErrUnsupportedProofType = errors.New("unsupported proof type")

// ErrUnknownContext is returned when the document loader is asked to
// resolve a JSON-LD `@context` URL that isn't in the vendored set.
// Fail-closed by design — the previous behavior of falling through to
// ld.NewDefaultDocumentLoader's HTTP GET would turn any pre-auth
// verification path into an SSRF + slow-loris amplifier. Signers MUST
// rebuild against the bundled context set; remote fetches are not part
// of the trust model.
var ErrUnknownContext = errors.New("unknown JSON-LD context")

// ErrCanonicalizationFailed is returned when json-gold cannot process a document the
// admission rules accepted: it panics, as it does for a graph container holding a
// number or a boolean, or it refuses the document while converting it to a dataset,
// as it does for a nested @context that redefines a protected term. It is not an
// admission refusal, since no admission rule describes the document, but like one it
// is the caller's document at fault. A failure to load or read a registered context is
// not reported with it.
var ErrCanonicalizationFailed = errors.New("canonicalization failed")

// ErrSignatureRecovery is returned when secp256k1 signer recovery
// produces a result that fails internal sanity checks (invalid recovery
// id, malformed compact signature). Distinct from ErrMalformedProof so
// callers can distinguish "the proof block was malformed" from "the
// signature bytes themselves don't recover a valid pubkey."
var ErrSignatureRecovery = errors.New("secp256k1 signature recovery failed")

// ErrEd25519Verify is returned when an Ed25519 signature verification
// fails. Maps to HTTP 401 / gRPC Unauthenticated.
var ErrEd25519Verify = errors.New("ed25519 signature verification failed")
