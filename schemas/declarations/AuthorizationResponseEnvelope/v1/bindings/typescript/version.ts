/*
 * Canonical declaration version every producer of AuthorizationResponseEnvelope
 * v1 messages MUST emit on the wire (the schema's `version` field). The
 * schema's regex locks the MAJOR component to the parent directory
 * (v1 → 1.x); this constant pins the MINOR.
 *
 * Bumping it is a single-line change here that producers pick up via
 * rebuild. Any new field added to the schema additively (i.e. without
 * breaking backward compatibility) lifts this to "1.N+1".
 *
 * The make verify-version target in schemas/Makefile asserts at CI
 * time that this constant matches the schema's `version` regex.
 */
export const VERSION = "1.0";

/*
 * CONTEXT_URL is the declaration @context IRI an AuthorizationResponseEnvelope (ARE)
 * carries at top level. Mirror of the Go binding's ContextURL — keep the two in
 * lock-step; the beneficiary-psp producer and payment-gw auth_response perimeter
 * assert against it rather than hand-copying the literal.
 */
export const CONTEXT_URL =
  "https://schemas.atum.network/declarations/AuthorizationResponseEnvelope/v1/context.jsonld";

/*
 * ENVELOPE_TYPE is the declaration term appended to the signed envelope's `type`
 * array; it is @type:@id-mapped in the declaration context so it emits an rdf:type
 * n-quad and is COVERED BY THE SIGNATURE, letting the ARE perimeter reject a
 * relabeled envelope. Mirror of the Go binding's EnvelopeType.
 */
export const ENVELOPE_TYPE = "AuthorizationResponseEnvelope";
