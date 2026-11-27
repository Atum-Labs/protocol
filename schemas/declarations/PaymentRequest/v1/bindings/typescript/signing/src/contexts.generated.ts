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
  "payment-request-context.jsonld": {
    "@context": {
      "@version": 1.1,
      "@protected": true,
      "atum": "https://schemas.atum.network/",
      "xsd": "http://www.w3.org/2001/XMLSchema#",
      "sec": "https://w3id.org/security#",
      "caip": "https://github.com/ChainAgnostic/CAIPs/",
      "dc": "http://purl.org/dc/terms/",
      "cred": "https://www.w3.org/2018/credentials#",
      "PaymentRequest": {
        "@id": "atum:PaymentRequest",
        "@type": "@id"
      },
      "payment_request": {
        "@id": "atum:paymentRequest",
        "@type": "@id"
      },
      "version": {
        "@id": "atum:version",
        "@type": "xsd:string"
      },
      "sender_auth": {
        "@id": "atum:senderAuth",
        "@type": "@id"
      },
      "originator_auth": {
        "@id": "atum:originatorAuth",
        "@type": "@id"
      },
      "request_id": {
        "@id": "atum:requestId",
        "@type": "xsd:string"
      },
      "source": {
        "@id": "atum:source",
        "@type": "@id"
      },
      "destination": {
        "@id": "atum:destination",
        "@type": "@id",
        "@container": "@set"
      },
      "fulfillment_amount": {
        "@id": "atum:fulfillmentAmount",
        "@type": "xsd:string"
      },
      "max_source_amount": {
        "@id": "atum:maxSourceAmount",
        "@type": "xsd:string"
      },
      "quote_deadline": {
        "@id": "atum:quoteDeadline",
        "@type": "xsd:dateTime"
      },
      "fulfillment_deadline": {
        "@id": "atum:fulfillmentDeadline",
        "@type": "xsd:dateTime"
      },
      "executor": {
        "@id": "atum:executor",
        "@type": "@json"
      },
      "deposit_nonce": {
        "@id": "atum:depositNonce",
        "@type": "xsd:string"
      },
      "settler_auth_required": {
        "@id": "atum:settlerAuthRequired",
        "@type": "@id"
      },
      "quote_selector": {
        "@id": "atum:quoteSelector",
        "@type": "xsd:string"
      },
      "fulfillment_verifier": {
        "@id": "atum:fulfillmentVerifier",
        "@type": "@id"
      },
      "escrow_contract_address": {
        "@id": "atum:escrowContractAddress",
        "@type": "xsd:string"
      },
      "fulfillment_proxy": {
        "@id": "atum:fulfillmentProxy",
        "@type": "xsd:string"
      },
      "endpoint": {
        "@id": "atum:endpoint",
        "@type": "xsd:anyURI"
      },
      "OwnedAsset": {
        "@id": "atum:OwnedAsset",
        "@type": "@id"
      },
      "asset_identifier": {
        "@id": "caip:assetIdentifier",
        "@type": "xsd:string"
      },
      "account": {
        "@id": "atum:account",
        "@type": "xsd:string"
      },
      "SenderAuth": {
        "@id": "atum:SenderAuth",
        "@type": "@id"
      },
      "auth": {
        "@id": "atum:auth",
        "@type": "@id"
      },
      "message_scheme": {
        "@id": "atum:messageScheme",
        "@type": "xsd:string"
      },
      "signed_messages": {
        "@id": "atum:signedMessages",
        "@type": "@id",
        "@container": "@set"
      },
      "SignedMessage": {
        "@id": "atum:SignedMessage",
        "@type": "@id"
      },
      "message": {
        "@id": "atum:message",
        "@type": "xsd:string"
      },
      "message_prehash": {
        "@id": "atum:messagePrehash",
        "@type": "xsd:string"
      },
      "signature": {
        "@id": "sec:signature",
        "@type": "xsd:string"
      },
      "payload": {
        "@id": "atum:payload",
        "@type": "@id"
      },
      "VerifiableCredentialAuth": {
        "@id": "atum:VerifiableCredentialAuth",
        "@type": "@id"
      },
      "verifiable_credential": {
        "@id": "atum:verifiableCredential",
        "@type": "@id"
      },
      "verification_method_id": {
        "@id": "sec:verificationMethod",
        "@type": "@id"
      },
      "VerifiableCredential": {
        "@id": "https://www.w3.org/2018/credentials#VerifiableCredential",
        "@type": "@id"
      },
      "settler_requirements": {
        "@id": "atum:settlerRequirements",
        "@type": "@id",
        "@container": "@set"
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
      },
      "presentation": {
        "@id": "atum:presentation",
        "@type": "@id"
      },
      "holder": {
        "@id": "cred:holder",
        "@type": "@id"
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
      }
    }
  } as unknown as JsonLdDocument,
};
