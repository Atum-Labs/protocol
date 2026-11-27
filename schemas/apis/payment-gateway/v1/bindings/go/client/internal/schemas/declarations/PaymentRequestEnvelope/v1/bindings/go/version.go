package paymentrequestenvelope

// Version is the canonical declaration version every producer of
// PaymentRequestEnvelope v1 messages MUST emit on the wire (the
// schema's `version` field). The schema's regex locks the MAJOR
// component to the parent directory (v1 → 1.x); this constant pins
// the MINOR.
//
// Bumping it is a single-line change here that producers pick up via
// recompile. Any new field added to the schema additively (i.e. without
// breaking backward compatibility) lifts this to "1.N+1".
//
// The make verify-version target in schemas/Makefile asserts at CI time
// that this constant matches the schema's `version` regex.
const Version = "1.0"

// ContextURL is the declaration @context IRI a PaymentRequestEnvelope (PRE)
// carries at top level. Single source of truth for the producer and the PRE
// verifiers, which previously hand-copied this string literal.
const ContextURL = "https://schemas.atum.network/declarations/PaymentRequestEnvelope/v1/context.jsonld"

// EnvelopeType is the declaration term bound into the signed envelope's
// `type` array, asserted by the verifiers (via ExpectedDeclarationType) to
// reject a relabeled FulfillmentQuoteEnvelope. Single source of truth shared
// by the producer and the verify side.
const EnvelopeType = "PaymentRequestEnvelope"
