// GENERATED FILE — DO NOT EDIT.
//
// Written by scripts/gen-pre-context.mjs from
// schemas/declarations/PaymentRequestEnvelope/v1/context.jsonld. Run `pnpm run prebuild`
// to regenerate; `pnpm run check:pre-context` fails if it has drifted.

// Deep-frozen at module load. This object is shared by every call, so a caller (or a
// library reaching into it) that mutated it would change what this package SIGNS for the
// rest of the process — silently, because the document still looks right and only the
// signature differs. Freezing makes that mutation fail instead of succeeding quietly.
//
// Consumers that need a mutable copy get one from structuredClone at the point of use;
// the JSON-LD processor is handed a clone for exactly that reason.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const PAYMENT_REQUEST_ENVELOPE_CONTEXT: Record<string, unknown> = deepFreeze(
  {
    "$comment": "Note on `verifiableCredential` (below): `@container: @graph` makes each VC its own RDF graph. URDNA2015 normalizes graphs order-independently AND deduplicates by node id — so (a) reordering the verifiableCredential array yields the same VP signature, and (b) identical-id VCs collapse to a single graph. This is the standard W3C VC array shape, identical to FulfillmentQuoteEnvelope/v1's context. MVP policy doesn't depend on order (`RequiredVCTypes` is set-based, `IsIssuerTrusted` is a per-VC predicate). If a future policy needs ordered VCs, swap `@graph` for `@list` here AND in the design doc — the order-dependent shape is a different canonicalization contract.",
    "@context": {
      "@version": 1.1,
      "@protected": true,
      "atum": "https://schemas.atum.network/",
      "xsd": "http://www.w3.org/2001/XMLSchema#",
      "sec": "https://w3id.org/security#",
      "dc": "http://purl.org/dc/terms/",
      "cred": "https://www.w3.org/2018/credentials#",
      "PaymentRequestEnvelope": {
        "@id": "atum:PaymentRequestEnvelope",
        "@type": "@id"
      },
      "VerifiablePresentation": {
        "@id": "cred:VerifiablePresentation",
        "@type": "@id"
      },
      "VerifiableCredential": {
        "@id": "cred:VerifiableCredential",
        "@type": "@id"
      },
      "version": {
        "@id": "atum:version",
        "@type": "xsd:string"
      },
      "holder": {
        "@id": "cred:holder",
        "@type": "@id"
      },
      "verifiableCredential": {
        "@id": "cred:verifiableCredential",
        "@type": "@id",
        "@container": "@graph"
      },
      "proof": {
        "@id": "sec:proof",
        "@type": "@id",
        "@container": "@graph"
      },
      "jws": {
        "@id": "sec:jws"
      },
      "proofValue": {
        "@id": "sec:proofValue"
      },
      "proofPurpose": {
        "@id": "sec:proofPurpose",
        "@type": "@vocab"
      },
      "verificationMethod": {
        "@id": "sec:verificationMethod",
        "@type": "@id"
      },
      "created": {
        "@id": "dc:created",
        "@type": "xsd:dateTime"
      },
      "challenge": {
        "@id": "sec:challenge"
      },
      "domain": {
        "@id": "sec:domain"
      },
      "authentication": {
        "@id": "sec:authentication",
        "@type": "@id"
      },
      "assertionMethod": {
        "@id": "sec:assertionMethod",
        "@type": "@id"
      }
    }
  },
);

// Copied from the canonical version module, NOT retyped. Both are bound into the holder
// signature, so a client carrying a stale copy would keep signing under terms the verifier
// has already moved on from -- and nothing would fail loudly.
export const PAYMENT_REQUEST_ENVELOPE_CONTEXT_URL = "https://schemas.atum.network/declarations/PaymentRequestEnvelope/v1/context.jsonld";
export const PAYMENT_REQUEST_ENVELOPE_TYPE = "PaymentRequestEnvelope";
