/*
 * Canonical declaration version every producer of BidDeclineEnvelope
 * v1 messages MUST emit on the wire (the schema's `version` field). The
 * schema's regex locks the MAJOR component to the parent directory
 * (v1 → 1.x); this constant pins the MINOR.
 *
 * The make verify-version target in schemas/Makefile asserts at CI
 * time that this constant matches the schema's `version` regex.
 */
export const VERSION = "1.0";

/*
 * CONTEXT_URL is the declaration @context IRI a BidDeclineEnvelope carries at top level.
 * Mirror of the Go binding's ContextURL.
 */
export const CONTEXT_URL =
  "https://schemas.atum.network/declarations/BidDeclineEnvelope/v1/context.jsonld";

/*
 * ENVELOPE_TYPE is the declaration term appended to the signed envelope's `type` array. It is
 * @type:@id-mapped in the envelope context, so it is covered by the signature. Mirror of the Go
 * binding's EnvelopeType.
 */
export const ENVELOPE_TYPE = "BidDeclineEnvelope";
