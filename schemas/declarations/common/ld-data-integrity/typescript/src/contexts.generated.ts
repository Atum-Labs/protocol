// GENERATED FILE — DO NOT EDIT.
//
// Written by scripts/copy-context.mjs from the Go lib's contexts/ tree, which is the
// source of truth for both language halves. Run `npm run prebuild` in this package to
// regenerate; `npm run verify-context` fails if it has drifted.
//
// Inlined rather than read from disk so the contexts survive being re-bundled by a
// consumer: a path relative to this module resolves against the consumer's output, and the
// shim needed to find it made one downstream ESM bundle unloadable.

import type { JsonLdDocument } from "jsonld";

// DEEP-FROZEN, and not as a formality. These are module-level objects: genericContexts()
// runs on every `new DocumentLoader(...)`, so the SAME object is shared by every loader in
// the process, and load(url) hands it straight out. Anything that mutates one changes what
// every later signature in that process is computed over -- silently, because the document
// still looks right and only the signed bytes differ. Freezing makes that a thrown error
// instead. The generated PRE context does the same, for the same reason.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const EMBEDDED_CONTEXTS: Record<string, JsonLdDocument> = deepFreeze({
  "credentials-v1.jsonld": {
    "@context": {
      "@version": 1.1,
      "@protected": true,
      "id": "@id",
      "type": "@type",
      "VerifiableCredential": {
        "@id": "https://www.w3.org/2018/credentials#VerifiableCredential",
        "@context": {
          "@version": 1.1,
          "@protected": true,
          "id": "@id",
          "type": "@type",
          "cred": "https://www.w3.org/2018/credentials#",
          "sec": "https://w3id.org/security#",
          "xsd": "http://www.w3.org/2001/XMLSchema#",
          "credentialSchema": {
            "@id": "cred:credentialSchema",
            "@type": "@id",
            "@context": {
              "@version": 1.1,
              "@protected": true,
              "id": "@id",
              "type": "@type",
              "cred": "https://www.w3.org/2018/credentials#",
              "JsonSchemaValidator2018": "cred:JsonSchemaValidator2018"
            }
          },
          "credentialStatus": {
            "@id": "cred:credentialStatus",
            "@type": "@id"
          },
          "credentialSubject": {
            "@id": "cred:credentialSubject",
            "@type": "@id"
          },
          "evidence": {
            "@id": "cred:evidence",
            "@type": "@id"
          },
          "expirationDate": {
            "@id": "cred:expirationDate",
            "@type": "xsd:dateTime"
          },
          "holder": {
            "@id": "cred:holder",
            "@type": "@id"
          },
          "issued": {
            "@id": "cred:issued",
            "@type": "xsd:dateTime"
          },
          "issuer": {
            "@id": "cred:issuer",
            "@type": "@id"
          },
          "issuanceDate": {
            "@id": "cred:issuanceDate",
            "@type": "xsd:dateTime"
          },
          "proof": {
            "@id": "sec:proof",
            "@type": "@id",
            "@container": "@graph"
          },
          "refreshService": {
            "@id": "cred:refreshService",
            "@type": "@id",
            "@context": {
              "@version": 1.1,
              "@protected": true,
              "id": "@id",
              "type": "@type",
              "cred": "https://www.w3.org/2018/credentials#",
              "ManualRefreshService2018": "cred:ManualRefreshService2018"
            }
          },
          "termsOfUse": {
            "@id": "cred:termsOfUse",
            "@type": "@id"
          },
          "validFrom": {
            "@id": "cred:validFrom",
            "@type": "xsd:dateTime"
          },
          "validUntil": {
            "@id": "cred:validUntil",
            "@type": "xsd:dateTime"
          }
        }
      },
      "VerifiablePresentation": {
        "@id": "https://www.w3.org/2018/credentials#VerifiablePresentation",
        "@context": {
          "@version": 1.1,
          "@protected": true,
          "id": "@id",
          "type": "@type",
          "cred": "https://www.w3.org/2018/credentials#",
          "sec": "https://w3id.org/security#",
          "holder": {
            "@id": "cred:holder",
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
            "@container": "@graph"
          }
        }
      },
      "EcdsaSecp256k1Signature2019": {
        "@id": "https://w3id.org/security#EcdsaSecp256k1Signature2019",
        "@context": {
          "@version": 1.1,
          "@protected": true,
          "id": "@id",
          "type": "@type",
          "sec": "https://w3id.org/security#",
          "xsd": "http://www.w3.org/2001/XMLSchema#",
          "challenge": "sec:challenge",
          "created": {
            "@id": "http://purl.org/dc/terms/created",
            "@type": "xsd:dateTime"
          },
          "domain": "sec:domain",
          "expires": {
            "@id": "sec:expiration",
            "@type": "xsd:dateTime"
          },
          "jws": "sec:jws",
          "nonce": "sec:nonce",
          "proofPurpose": {
            "@id": "sec:proofPurpose",
            "@type": "@vocab",
            "@context": {
              "@version": 1.1,
              "@protected": true,
              "id": "@id",
              "type": "@type",
              "sec": "https://w3id.org/security#",
              "assertionMethod": {
                "@id": "sec:assertionMethod",
                "@type": "@id",
                "@container": "@set"
              },
              "authentication": {
                "@id": "sec:authenticationMethod",
                "@type": "@id",
                "@container": "@set"
              }
            }
          },
          "proofValue": "sec:proofValue",
          "verificationMethod": {
            "@id": "sec:verificationMethod",
            "@type": "@id"
          }
        }
      },
      "EcdsaSecp256r1Signature2019": {
        "@id": "https://w3id.org/security#EcdsaSecp256r1Signature2019",
        "@context": {
          "@version": 1.1,
          "@protected": true,
          "id": "@id",
          "type": "@type",
          "sec": "https://w3id.org/security#",
          "xsd": "http://www.w3.org/2001/XMLSchema#",
          "challenge": "sec:challenge",
          "created": {
            "@id": "http://purl.org/dc/terms/created",
            "@type": "xsd:dateTime"
          },
          "domain": "sec:domain",
          "expires": {
            "@id": "sec:expiration",
            "@type": "xsd:dateTime"
          },
          "jws": "sec:jws",
          "nonce": "sec:nonce",
          "proofPurpose": {
            "@id": "sec:proofPurpose",
            "@type": "@vocab",
            "@context": {
              "@version": 1.1,
              "@protected": true,
              "id": "@id",
              "type": "@type",
              "sec": "https://w3id.org/security#",
              "assertionMethod": {
                "@id": "sec:assertionMethod",
                "@type": "@id",
                "@container": "@set"
              },
              "authentication": {
                "@id": "sec:authenticationMethod",
                "@type": "@id",
                "@container": "@set"
              }
            }
          },
          "proofValue": "sec:proofValue",
          "verificationMethod": {
            "@id": "sec:verificationMethod",
            "@type": "@id"
          }
        }
      },
      "Ed25519Signature2018": {
        "@id": "https://w3id.org/security#Ed25519Signature2018",
        "@context": {
          "@version": 1.1,
          "@protected": true,
          "id": "@id",
          "type": "@type",
          "sec": "https://w3id.org/security#",
          "xsd": "http://www.w3.org/2001/XMLSchema#",
          "challenge": "sec:challenge",
          "created": {
            "@id": "http://purl.org/dc/terms/created",
            "@type": "xsd:dateTime"
          },
          "domain": "sec:domain",
          "expires": {
            "@id": "sec:expiration",
            "@type": "xsd:dateTime"
          },
          "jws": "sec:jws",
          "nonce": "sec:nonce",
          "proofPurpose": {
            "@id": "sec:proofPurpose",
            "@type": "@vocab",
            "@context": {
              "@version": 1.1,
              "@protected": true,
              "id": "@id",
              "type": "@type",
              "sec": "https://w3id.org/security#",
              "assertionMethod": {
                "@id": "sec:assertionMethod",
                "@type": "@id",
                "@container": "@set"
              },
              "authentication": {
                "@id": "sec:authenticationMethod",
                "@type": "@id",
                "@container": "@set"
              }
            }
          },
          "proofValue": "sec:proofValue",
          "verificationMethod": {
            "@id": "sec:verificationMethod",
            "@type": "@id"
          }
        }
      },
      "RsaSignature2018": {
        "@id": "https://w3id.org/security#RsaSignature2018",
        "@context": {
          "@version": 1.1,
          "@protected": true,
          "challenge": "sec:challenge",
          "created": {
            "@id": "http://purl.org/dc/terms/created",
            "@type": "xsd:dateTime"
          },
          "domain": "sec:domain",
          "expires": {
            "@id": "sec:expiration",
            "@type": "xsd:dateTime"
          },
          "jws": "sec:jws",
          "nonce": "sec:nonce",
          "proofPurpose": {
            "@id": "sec:proofPurpose",
            "@type": "@vocab",
            "@context": {
              "@version": 1.1,
              "@protected": true,
              "id": "@id",
              "type": "@type",
              "sec": "https://w3id.org/security#",
              "assertionMethod": {
                "@id": "sec:assertionMethod",
                "@type": "@id",
                "@container": "@set"
              },
              "authentication": {
                "@id": "sec:authenticationMethod",
                "@type": "@id",
                "@container": "@set"
              }
            }
          },
          "proofValue": "sec:proofValue",
          "verificationMethod": {
            "@id": "sec:verificationMethod",
            "@type": "@id"
          }
        }
      },
      "proof": {
        "@id": "https://w3id.org/security#proof",
        "@type": "@id",
        "@container": "@graph"
      }
    }
  } as unknown as JsonLdDocument,
  "secp256k1recovery-2020-v2.jsonld": {
    "@context": {
      "sec": "https://w3id.org/security#",
      "xsd": "http://www.w3.org/2001/XMLSchema#",
      "EcdsaSecp256k1RecoverySignature2020": "sec:EcdsaSecp256k1RecoverySignature2020",
      "type": "@type",
      "created": {
        "@id": "http://purl.org/dc/terms/created",
        "@type": "xsd:dateTime"
      },
      "verificationMethod": {
        "@id": "sec:verificationMethod",
        "@type": "@id"
      },
      "proofPurpose": {
        "@id": "sec:proofPurpose",
        "@type": "@vocab"
      },
      "assertionMethod": {
        "@id": "sec:assertionMethod",
        "@type": "@id"
      },
      "jws": {
        "@id": "sec:jws"
      }
    }
  } as unknown as JsonLdDocument,
  "ed25519-2020-v1.jsonld": {
    "$comment": "Ed25519Signature2020 v1 cryptosuite context. Vendored snapshot of https://w3id.org/security/suites/ed25519-2020/v1 — used by URDNA2015 to bind term IRIs at canonicalization time without a network fetch. Includes the W3C VC §5.6 VerifiablePresentation terms (authentication, challenge, domain) so VP-proof canonicalization resolves them locally; FQ FulfillmentQuote-proof callers leave those fields empty and the block canonicalizes identically to the bare cryptosuite shape. Mirrors the TS signer's local context definition so canonical n-quads are byte-identical across the two language bindings.",
    "@context": {
      "sec": "https://w3id.org/security#",
      "xsd": "http://www.w3.org/2001/XMLSchema#",
      "Ed25519Signature2020": "sec:Ed25519Signature2020",
      "Ed25519VerificationKey2020": "sec:Ed25519VerificationKey2020",
      "type": "@type",
      "created": {
        "@id": "http://purl.org/dc/terms/created",
        "@type": "xsd:dateTime"
      },
      "verificationMethod": {
        "@id": "sec:verificationMethod",
        "@type": "@id"
      },
      "proofPurpose": {
        "@id": "sec:proofPurpose",
        "@type": "@vocab"
      },
      "assertionMethod": {
        "@id": "sec:assertionMethod",
        "@type": "@id"
      },
      "authentication": {
        "@id": "sec:authentication",
        "@type": "@id"
      },
      "proofValue": {
        "@id": "sec:proofValue"
      },
      "challenge": {
        "@id": "sec:challenge"
      },
      "domain": {
        "@id": "sec:domain"
      }
    }
  } as unknown as JsonLdDocument,
  "known-to-atum-v1.jsonld": {
    "@context": {
      "@version": 1.1,
      "@protected": true,
      "xsd": "http://www.w3.org/2001/XMLSchema#",
      "kta": "https://schemas.atum.xyz/credentials/known-to-atum/v1#",
      "KnownToAtumVerifiableCredential": "kta:KnownToAtumVerifiableCredential",
      "role": {
        "@id": "kta:role",
        "@type": "@vocab"
      },
      "settler": "kta:settler",
      "psp": "kta:psp",
      "atumOperatedService": "kta:atumOperatedService",
      "knownToAtum": {
        "@id": "kta:knownToAtum",
        "@type": "xsd:boolean"
      }
    }
  } as unknown as JsonLdDocument,
  "known-to-atum-v2.jsonld": {
    "@context": {
      "@version": 1.1,
      "@protected": true,
      "xsd": "http://www.w3.org/2001/XMLSchema#",
      "kta": "https://schemas.atum.xyz/credentials/known-to-atum/v1#",
      "KnownToAtumVerifiableCredential": "kta:KnownToAtumVerifiableCredential",
      "role": {
        "@id": "kta:role",
        "@type": "@vocab"
      },
      "settler": "kta:settler",
      "psp": "kta:psp",
      "atumOperatedService": "kta:atumOperatedService",
      "quoteAwarder": "kta:quoteAwarder",
      "merchant": "kta:merchant",
      "knownToAtum": {
        "@id": "kta:knownToAtum",
        "@type": "xsd:boolean"
      }
    }
  } as unknown as JsonLdDocument,
  "kyc-v1.jsonld": {
    "@context": {
      "@version": 1.1,
      "@protected": true,
      "kyc": "https://schemas.atum.xyz/credentials/kyc/v1#",
      "KYCCredential": "kyc:KYCCredential",
      "kycStatus": {
        "@id": "kyc:kycStatus",
        "@type": "@vocab"
      },
      "approved": "kyc:approved",
      "rejected": "kyc:rejected",
      "pending": "kyc:pending",
      "expired": "kyc:expired"
    }
  } as unknown as JsonLdDocument,
  "sender-compliance-v1.jsonld": {
    "@context": {
      "@version": 1.1,
      "@protected": true,
      "sc": "https://schemas.atum.xyz/credentials/sender-compliance/v1#",
      "SenderComplianceCredential": "sc:SenderComplianceCredential",
      "complianceStatus": {
        "@id": "sc:complianceStatus",
        "@type": "@vocab"
      },
      "approved": "sc:approved",
      "rejected": "sc:rejected",
      "pending": "sc:pending"
    }
  } as unknown as JsonLdDocument,
});
