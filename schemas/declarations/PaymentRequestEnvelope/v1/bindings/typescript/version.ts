/*
 * Canonical declaration version every producer of PaymentRequestEnvelope
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
 * CONTEXT_URL is the declaration @context IRI a PaymentRequestEnvelope (PRE)
 * carries — the originator-side envelope's own declaration context. A TS PRE
 * producer passes this as signVP's `envelopeContextUrl` and overlays the
 * parsed context via `extraEnvelopeContexts` so the envelope canonicalizes
 * under the strict no-network loader. Mirror of the Go binding's ContextURL;
 * keep the two in lock-step.
 */
export const CONTEXT_URL =
  "https://schemas.atum.network/declarations/PaymentRequestEnvelope/v1/context.jsonld";

/*
 * ENVELOPE_TYPE is the declaration term appended to the signed envelope's
 * `type` array (e.g. type: ["VerifiablePresentation","PaymentRequestEnvelope"]).
 * The term is @type:@id-mapped in the declaration context, so it emits an
 * rdf:type n-quad and is COVERED BY THE SIGNATURE — binding the envelope kind
 * into the proof so a verifier can reject a relabeled envelope. Mirror of the
 * Go binding's EnvelopeType.
 */
export const ENVELOPE_TYPE = "PaymentRequestEnvelope";
