package paymentrequestenvelope

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

// embeddedContext is the PRE @context, snapshotted here because go:embed cannot reach the
// canonical file outside its own package directory. The Makefile's verify-context target diffs
// this snapshot against that canonical source and CI runs it through schemas/Makefile's
// LD_VERIFICATION_MODULES, so drift fails the build rather than silently changing what an
// envelope signature is computed over.
//
//go:embed contexts/payment-request-envelope-context.jsonld
var embeddedContext []byte

// ParsedContext returns the PRE @context, parsed and ready to pass as
// VerifyVPOptions.ExtraEnvelopeContexts.
//
// IT LIVES HERE, BESIDE ContextURL AND EnvelopeType, RATHER THAN IN signing/. A PRE VERIFIER
// needs this context — it is deliberately not registered on the FulfillmentQuote verifier's
// global loader, so every verifier has to supply it per call. Putting it in the signing package
// meant a pure verifier had to import the envelope SIGNER just to read a JSON file, which is an
// inversion that spreads to every service that verifies. This package is the one all of them
// already import for ContextURL and EnvelopeType.
//
// Without an accessor each verifier embeds its own copy of the same file, which is exactly how
// the drifted copies this replaced came to exist.
//
// Returning the error rather than panicking keeps a corrupt snapshot a handled failure on the
// verify path.
func ParsedContext() (any, error) {
	// Parsed fresh rather than handing out a package-level value. Handing out the live context
	// aliases it: a caller that mutates the returned map — or a library that does — changes what
	// every later signature in the process is computed over, silently, because the document
	// still looks right and only the signed bytes differ. A verifier holds this same value as
	// its loader overlay, so the blast radius is both halves at once.
	//
	// The cost is one parse per call. Callers resolve it once at startup.
	var ctx any
	if err := json.Unmarshal(embeddedContext, &ctx); err != nil {
		return nil, fmt.Errorf("paymentrequestenvelope: embedded context is corrupt: %w", err)
	}
	return ctx, nil
}
