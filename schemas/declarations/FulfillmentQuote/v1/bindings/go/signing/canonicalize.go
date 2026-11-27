package ldverification

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// FQ-specific JSON-LD contexts. The shared lib owns the generic ones
// (W3C VC v1, secp256k1recovery-2020-v2, ed25519-2020-v1, known-to-atum-v1);
// FQ keeps only its declaration-specific contexts here. The Makefile's
// update-context target keeps these in sync with the canonical sources
// under schemas/declarations/FulfillmentQuote{,Envelope}/v1/context.jsonld.

//go:embed contexts/fulfillment-quote-context.jsonld
var fulfillmentQuoteContext []byte

//go:embed contexts/fulfillment-quote-envelope-context.jsonld
var fulfillmentQuoteEnvelopeContext []byte

// fqLoader is the process-level strict-no-network document loader for
// FQ canonicalization. Built once at init from the shared lib's
// generic-context base, with FQ-specific contexts overlaid via the
// Extra map. Holds the load-bearing SSRF defense (unknown URLs fail
// closed) inherited from the lib.
//
// Concurrency-safe by construction — the loader's context map is
// immutable after NewDocumentLoader returns.
var fqLoader = newFQLoader()

func newFQLoader() *lddataintegrity.DocumentLoader {
	return lddataintegrity.NewDocumentLoader(map[string]any{
		"https://schemas.atum.network/declarations/FulfillmentQuote/v1/context.jsonld":         mustParseFQContext(fulfillmentQuoteContext),
		"https://schemas.atum.network/declarations/FulfillmentQuoteEnvelope/v1/context.jsonld": mustParseFQContext(fulfillmentQuoteEnvelopeContext),
	})
}

// loaderWithExtraEnvelopeContexts returns a per-call loader = fqLoader's
// registered set (FQ + FQE + generic contexts) overlaid with `extra`.
// Returns fqLoader itself when `extra` is empty so the common FQ path
// keeps using the shared process-global instance (no per-call alloc).
//
// VerifyVP overlays the originator-side envelope declaration's context
// (PaymentRequestEnvelope) here when the caller supplies it via
// VerifyVPOptions.ExtraEnvelopeContexts. The overlay lives on a throwaway
// loader — fqLoader is never mutated — so FQ's settler-side global never
// learns about originator schemas (the firm layering boundary).
func loaderWithExtraEnvelopeContexts(extra map[string]any) *lddataintegrity.DocumentLoader {
	if len(extra) == 0 {
		return fqLoader
	}
	return fqLoader.WithExtraContexts(extra)
}

// mustParseFQContext panics if an FQ-specific embedded context is
// corrupt. The asset is bundled at build time via go:embed, so a parse
// failure means the binary is corrupt — surfacing at init beats silent
// downstream signature divergence.
func mustParseFQContext(asset []byte) any {
	var ctx any
	if err := json.Unmarshal(asset, &ctx); err != nil {
		panic(fmt.Errorf("ldverification: embedded FQ JSON-LD context is corrupt: %w", err))
	}
	return ctx
}

// Canonicalize performs URDNA2015 canonicalization on a JSON-LD
// document, delegating to the shared data-integrity library's
// implementation with FQ's declaration-specific contexts overlaid.
//
// Error taxonomy preserved for back-compat: unknown @context URLs
// (the lib's ErrUnknownContext) are wrapped in FQ's ErrMalformedQuote
// so callers that used errors.Is(..., ErrMalformedQuote) to classify
// malformed-input failures keep working. A document the lib's admission
// check refuses is wrapped in ErrMalformedQuote too, and keeps the lib's
// *AdmissionError in the chain for callers that want the rule and path;
// so is a document the lib cannot canonicalize at all, which keeps the
// lib's ErrCanonicalizationFailed in the chain.
func Canonicalize(doc interface{}) (string, error) {
	nquads, err := lddataintegrity.Canonicalize(doc, fqLoader)
	if err != nil {
		// Lib returns ErrUnknownContext for unknown @context URLs +
		// json-gold's verbatim errors for malformed-shape cases. Wrap
		// in FQ's ErrMalformedQuote so the FQ-side error taxonomy
		// stays unchanged. The lib's URL is still
		// in the error chain (we use %w) so log diagnostics that
		// match on the URL string keep working.
		if errors.Is(err, lddataintegrity.ErrUnknownContext) {
			return "", fmt.Errorf("%w: %w", ErrMalformedQuote, err)
		}
		// Both wrapped: a caller classifying by this package's taxonomy and one
		// asking why the lib refused must each find their sentinel.
		if errors.Is(err, lddataintegrity.ErrNotCanonicalizable) ||
			errors.Is(err, lddataintegrity.ErrCanonicalizationFailed) {
			return "", fmt.Errorf("%w: %w", ErrMalformedQuote, err)
		}
		return "", err
	}
	return nquads, nil
}
