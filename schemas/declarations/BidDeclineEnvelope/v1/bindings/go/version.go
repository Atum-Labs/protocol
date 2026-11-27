package biddeclineenvelope

// Version is the canonical declaration version every producer of
// BidDeclineEnvelope v1 messages MUST emit on the wire (the
// schema's `version` field). The schema's regex locks the MAJOR
// component to the parent directory (v1 → 1.x); this constant pins
// the MINOR.
//
// The make verify-version target in schemas/Makefile asserts at CI time
// that this constant matches the schema's `version` regex.
const Version = "1.0"

// ContextURL is the declaration @context IRI a BidDeclineEnvelope carries at top level,
// shared by the settler producer and the gateway verifier.
const ContextURL = "https://schemas.atum.network/declarations/BidDeclineEnvelope/v1/context.jsonld"

// EnvelopeType is the declaration term bound into the signed envelope's `type` array. The
// verifier asserts it (ExpectedDeclarationType) to reject a presentation made for another declaration.
const EnvelopeType = "BidDeclineEnvelope"
