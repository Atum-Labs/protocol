// GENERATED FILE — DO NOT EDIT.
//
// Written by scripts/copy-context.mjs from the canonical context.jsonld files. Run
// `npm run prebuild` in this package to regenerate; `npm run verify-context` fails if it
// has drifted.
//
// Inlined rather than read from disk so the contexts survive being re-bundled: nothing
// here touches the filesystem or the network at resolution time.

import type { JsonLdDocument } from "jsonld";

export const EMBEDDED_CONTEXTS: Record<string, JsonLdDocument> = {
  "fulfillment-quote-context.jsonld": {
    "@context": {
      "@version": 1.1,
      "@protected": true,
      "atum": "https://schemas.atum.network/",
      "xsd": "http://www.w3.org/2001/XMLSchema#",
      "caip": "https://github.com/ChainAgnostic/CAIPs/",
      "sec": "https://w3id.org/security#",
      "dc": "http://purl.org/dc/terms/",
      "cred": "https://www.w3.org/2018/credentials#",
      "FulfillmentQuote": {
        "@id": "atum:FulfillmentQuote",
        "@type": "@id"
      },
      "fulfillment_quote": {
        "@id": "atum:fulfillmentQuote",
        "@type": "@id"
      },
      "version": {
        "@id": "atum:version",
        "@type": "xsd:string"
      },
      "source_amount": {
        "@id": "atum:sourceAmount",
        "@type": "xsd:string"
      },
      "award_deadline": {
        "@id": "atum:awardDeadline",
        "@type": "xsd:dateTime"
      },
      "source": {
        "@id": "atum:source",
        "@type": "@id"
      },
      "destination": {
        "@id": "atum:destination",
        "@type": "@id"
      },
      "payment_request_json": {
        "@id": "atum:paymentRequestJson",
        "@type": "xsd:string"
      },
      "settler_address": {
        "@id": "atum:settlerAddress",
        "@type": "xsd:string"
      },
      "Asset": {
        "@id": "atum:Asset",
        "@type": "@id"
      },
      "account": {
        "@id": "atum:account",
        "@type": "xsd:string"
      },
      "VerifiableCredential": {
        "@id": "https://www.w3.org/2018/credentials#VerifiableCredential",
        "@type": "@id"
      },
      "proof": {
        "@id": "sec:proof",
        "@type": "@id",
        "@container": "@graph"
      },
      "verifiableCredential": {
        "@id": "cred:verifiableCredential",
        "@type": "@id",
        "@container": "@set"
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
      "assertionMethod": {
        "@id": "sec:assertionMethod",
        "@type": "@id"
      }
    }
  } as unknown as JsonLdDocument,
  "fulfillment-quote-envelope-context.jsonld": {
    "$comment": "Note on `verifiableCredential` (below): `@container: @graph` makes each VC its own RDF graph. URDNA2015 normalizes graphs order-independently AND deduplicates by node id — so (a) reordering the verifiableCredential array yields the same VP signature, and (b) identical-id VCs collapse to a single graph. This is the standard W3C VC array shape. MVP policy doesn't depend on order (`RequiredVCTypes` is set-based, `IsIssuerTrusted` is a per-VC predicate). If a future policy needs ordered VCs, swap `@graph` for `@list` here AND in the design doc — the order-dependent shape is a different canonicalization contract.",
    "@context": {
      "@version": 1.1,
      "@protected": true,
      "atum": "https://schemas.atum.network/",
      "xsd": "http://www.w3.org/2001/XMLSchema#",
      "sec": "https://w3id.org/security#",
      "dc": "http://purl.org/dc/terms/",
      "cred": "https://www.w3.org/2018/credentials#",
      "FulfillmentQuoteEnvelope": {
        "@id": "atum:FulfillmentQuoteEnvelope",
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
  } as unknown as JsonLdDocument,
};
