// Package signing builds the holder-signed PaymentRequestEnvelope (PRE): the
// originator-side W3C VerifiablePresentation that mirrors the FulfillmentQuoteEnvelope (FQE).
//
// The PRE wraps (a) a Data Integrity-signed inner PaymentRequest and (b) the
// originator's issuer-signed credentials, all presented under a holder
// signature whose proof.challenge binds the payment/request id and whose
// proof.domain binds the environment. The gateway re-verifies the
// envelope before persisting the payment.
//
// # Scope
//
// This package owns envelope CONSTRUCTION only, and is deliberately key- and
// credential-injectable: the holder signing key and the credential bag are
// passed in by the caller, not sourced here. That keeps it usable by a service
// whose keys live behind a KMS and by an integrator holding a raw key, without
// either shape leaking into the envelope.
//
// # Where the signing actually happens
//
// Nothing here is new cryptography. The outer holder proof comes from
// FulfillmentQuote's SignVP, which is generic over the envelope context, and
// the inner document proof comes from PaymentRequest's own signer. Two
// originator-side differences from an FQE are set here: the envelope carries
// the PRE declaration context rather than the FQE one, and proof.domain is the
// network-wide, environment-suffixed did:web rather than one bound to a single service.
package signing

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	fqsigning "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/FulfillmentQuote/v1/bindings/go/signing"
	prsigning "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/signing"
	paymentrequestenvelope "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequestEnvelope/v1/bindings/go"
	lddataintegrity "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/common/ld-data-integrity/go"
)

// innerProofPurpose is the proofPurpose of the inner PaymentRequest proof. It
// differs from the envelope's own purpose: the inner document is asserted by
// its signer, while the envelope authenticates its holder. SignVP fixes
// "authentication" for the outer proof itself.
const innerProofPurpose = "assertionMethod"

// didPKHPrefix and blockchainAccountIDFragment build the holder's did:pkh DID
// URL from a CAIP-2 chain and account. Constructed rather than imported: the
// did:pkh helpers elsewhere in this repo are parse-only with unexported
// prefixes, and a consumer-side equivalent lives outside this repo, which this
// one cannot depend on.
const (
	didPKHPrefix                = "did:pkh:"
	blockchainAccountIDFragment = "#blockchainAccountId"
)

// ParsedContext is re-exported from the bindings package, which now owns the snapshot.
//
// It moved there so a PRE VERIFIER does not have to import this SIGNER just to read a JSON
// file — the bindings package is what every verifier already imports for ContextURL and
// EnvelopeType. This alias keeps the existing call sites working.
var ParsedContext = paymentrequestenvelope.ParsedContext

// envelopeContextFor is the indirection BuildEnvelope signs through. It exists so a test can
// substitute a deliberately altered context and assert what that alteration does to the
// signature — specifically that a $comment beside @context changes nothing, which is what makes
// the previously divergent copies interchangeable. Production always resolves to ParsedContext.
var envelopeContextFor = ParsedContext

// Options are the inputs to BuildEnvelope. Every field is required unless
// documented otherwise.
type Options struct {
	// PaymentRequestDoc is the inner PaymentRequest payload WITHOUT an
	// @context or proof block; the inner signer injects both.
	PaymentRequestDoc map[string]any

	// HolderVCs is the originator's issuer-signed credential bag, each a
	// fully-formed W3C VC with its own @context and proof. MUST be non-empty:
	// the envelope schema requires at least one and the verifier rejects an
	// empty bag.
	HolderVCs []json.RawMessage

	// Signer produces the holder's secp256k1 signature over a 32-byte digest.
	// Its public key MUST correspond to HolderAddress, because the verifier
	// binds the recovered signer back to the holder DID derived from ChainID
	// and HolderAddress. An interface rather than a key, so the same envelope
	// shape works for a raw local key and a remote KMS.
	Signer lddataintegrity.Secp256k1Signer

	// ChainID is the CAIP-2 chain of the holder account (e.g. "eip155:1"). It
	// drives the did:pkh namespace.
	ChainID string

	// HolderAddress is the holder's account on that chain.
	HolderAddress string

	// Challenge is the cross-request replay binding: the payment or request
	// id. The gateway asserts proof.challenge equals it.
	Challenge string

	// Domain is the cross-environment replay binding: the network-wide,
	// env-suffixed did:web identifier (e.g. did:web:devnet.atum.network). NOT
	// service-bound, because the envelope has several consumers.
	Domain string

	// Now anchors proof.created on both the inner and outer proofs. Injectable
	// so a test can pin an instant; it is inside the signed payload, so two
	// signatures over the same inputs differ unless it is fixed.
	Now time.Time
}

// HolderDID returns the did:pkh identifier the envelope's holder is named by.
func (o Options) HolderDID() string {
	return didPKHPrefix + o.ChainID + ":" + o.HolderAddress
}

// VerificationMethod returns the DID URL naming the holder's signing key.
func (o Options) VerificationMethod() string {
	return o.HolderDID() + blockchainAccountIDFragment
}

// BuildEnvelope wraps the holder's credentials in a holder-signed
// PaymentRequestEnvelope and returns the envelope JSON.
//
// It does NOT sign the inner PaymentRequest. The inner document is a separate
// artifact, produced by SignInnerPaymentRequest and carried alongside the
// envelope; the verifier checks the two independently and asserts the inner
// signer is this envelope's holder. Keeping them apart avoids signing the same
// key's inner proof twice when a producer needs both.
func BuildEnvelope(opts Options) ([]byte, error) {
	if err := validateEnvelopeOptions(opts); err != nil {
		return nil, err
	}

	envelopeCtx, err := envelopeContextFor()
	if err != nil {
		return nil, err
	}

	envelopeJSON, err := fqsigning.SignVPWithSigner(opts.HolderVCs, opts.Signer, fqsigning.SignVPOptions{
		Holder:             opts.HolderDID(),
		VerificationMethod: opts.VerificationMethod(),
		Challenge:          opts.Challenge,
		Domain:             opts.Domain,
		Created:            opts.Now,
		DeclarationType:    paymentrequestenvelope.EnvelopeType,
		// The override is what makes this a PRE rather than an FQE, and the
		// overlay is what lets the signer's document loader resolve the PRE
		// context offline at canonicalization time.
		EnvelopeContextURL: paymentrequestenvelope.ContextURL,
		// A COPY, not the package-level value. ParsedContext's own doc says handing out the
		// live context aliases it -- "or a library that does" -- and this is the one path
		// where that library is json-gold, reached through SignVPWithSigner. Whether
		// json-gold mutates it is not the point: the cost of one parse is small enough that
		// the safety of every later envelope in the process should not rest on a third
		// party's internals while the accessor beside it takes the opposite view.
		ExtraEnvelopeContexts: map[string]any{paymentrequestenvelope.ContextURL: envelopeCtx},
	})
	if err != nil {
		return nil, fmt.Errorf("pre: sign PaymentRequestEnvelope: %w", err)
	}
	return envelopeJSON, nil
}

// SignInnerPaymentRequest signs ONLY the inner PaymentRequest and returns its
// Data Integrity-signed JSON, using the same holder identity as BuildEnvelope
// so the inner signer and the outer holder are the same did:pkh — the
// consistency the envelope verifier anchors on.
func SignInnerPaymentRequest(opts Options) ([]byte, error) {
	if err := validateInnerOptions(opts); err != nil {
		return nil, err
	}
	return prsigning.SignPaymentRequestWithSigner(opts.PaymentRequestDoc, opts.Signer, prsigning.SignOptions{
		VerificationMethod: opts.VerificationMethod(),
		ProofPurpose:       innerProofPurpose,
		Created:            opts.Now,
	})
}

// validateEnvelopeOptions checks what BuildEnvelope actually READS.
//
// It deliberately does not chain through validateInnerOptions: PaymentRequestDoc belongs to
// SignInnerPaymentRequest, and requiring it here forced a caller who wants only an envelope to
// invent a dummy map to get past validation. The TypeScript buildEnvelope asks for no such
// thing, so the two halves of one SDK disagreed about their required inputs -- which is exactly
// what a customer hits when porting between them.
func validateEnvelopeOptions(opts Options) error {
	if err := validateSharedOptions(opts); err != nil {
		return err
	}
	if len(opts.HolderVCs) == 0 {
		return errors.New("pre: HolderVCs is empty (the envelope requires at least one credential)")
	}
	if opts.Challenge == "" {
		return errors.New("pre: Challenge required (payment/request id replay binding)")
	}
	if opts.Domain == "" {
		return errors.New("pre: Domain required (network-wide env-suffixed did:web replay binding)")
	}
	return nil
}

// validateInnerOptions is validateSharedOptions plus the inner document, which only
// SignInnerPaymentRequest reads.
func validateInnerOptions(opts Options) error {
	if opts.PaymentRequestDoc == nil {
		return errors.New("pre: PaymentRequestDoc required")
	}
	return validateSharedOptions(opts)
}

// validateSharedOptions checks the fields BOTH entry points read.
func validateSharedOptions(opts Options) error {
	if opts.Signer == nil {
		return errors.New("pre: Signer required")
	}
	if opts.ChainID == "" {
		return errors.New("pre: ChainID required")
	}
	if opts.HolderAddress == "" {
		return errors.New("pre: HolderAddress required")
	}
	if opts.Now.IsZero() {
		return errors.New("pre: Now required (proof.created anchor)")
	}
	return nil
}
