package ldverification

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// PaymentRequest-specific JSON-LD context. The shared lib owns the
// generic ones (W3C VC v1, secp256k1recovery-2020-v2, ed25519-2020-v1,
// known-to-atum-v1); PaymentRequest keeps only its declaration-specific
// context here. The Makefile's update-context target keeps this in sync
// with the canonical source under
// schemas/declarations/PaymentRequest/v1/context.jsonld.

//go:embed contexts/payment-request-context.jsonld
var paymentRequestContext []byte

// prLoader is the process-level strict-no-network document loader for
// PaymentRequest canonicalization. Built once at init from the shared
// lib's generic-context base, with the PaymentRequest context overlaid
// via the Extra map. Holds the load-bearing SSRF defense (unknown URLs
// fail closed) inherited from the lib.
//
// Concurrency-safe by construction — the loader's context map is
// immutable after NewDocumentLoader returns.
var prLoader = newPRLoader()

func newPRLoader() *lddataintegrity.DocumentLoader {
	return lddataintegrity.NewDocumentLoader(map[string]any{
		paymentRequestContextURL: mustParsePRContext(paymentRequestContext),
	})
}

// mustParsePRContext panics if the PaymentRequest embedded context is
// corrupt. The asset is bundled at build time via go:embed, so a parse
// failure means the binary is corrupt — surfacing at init beats silent
// downstream signature divergence.
func mustParsePRContext(asset []byte) any {
	var ctx any
	if err := json.Unmarshal(asset, &ctx); err != nil {
		panic(fmt.Errorf("ldverification: embedded PaymentRequest JSON-LD context is corrupt: %w", err))
	}
	return ctx
}

// Canonicalize performs URDNA2015 canonicalization on a JSON-LD
// document, delegating to the shared Go data-integrity implementation
// with PaymentRequest's declaration-specific context overlaid.
//
// Error taxonomy: unknown @context URLs (the lib's ErrUnknownContext)
// are wrapped in PaymentRequest's ErrMalformedRequest so callers that
// classify malformed-input failures via
// errors.Is(..., ErrMalformedRequest) get a single check. The lib's URL
// is still in the error chain (we use %w) so log diagnostics that match
// on the URL string keep working. A document the lib's admission check
// refuses is wrapped in ErrMalformedRequest too, and keeps the lib's
// *AdmissionError in the chain for callers that want the rule and path;
// so is a document the lib cannot canonicalize at all, which keeps the
// lib's ErrCanonicalizationFailed in the chain.
func Canonicalize(doc interface{}) (string, error) {
	nquads, err := lddataintegrity.Canonicalize(doc, prLoader)
	if err != nil {
		// Lib returns ErrUnknownContext for unknown @context URLs +
		// json-gold's verbatim errors for malformed-shape cases. Wrap
		// in PaymentRequest's ErrMalformedRequest so the PR-side error
		// taxonomy mirrors FQ's.
		if errors.Is(err, lddataintegrity.ErrUnknownContext) {
			return "", fmt.Errorf("%w: %w", ErrMalformedRequest, err)
		}
		// Both wrapped: a caller classifying by this package's taxonomy and one
		// asking why the lib refused must each find their sentinel.
		if errors.Is(err, lddataintegrity.ErrNotCanonicalizable) ||
			errors.Is(err, lddataintegrity.ErrCanonicalizationFailed) {
			return "", fmt.Errorf("%w: %w", ErrMalformedRequest, err)
		}
		return "", err
	}
	return nquads, nil
}
