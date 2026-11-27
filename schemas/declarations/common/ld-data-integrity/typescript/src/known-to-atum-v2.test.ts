// Mirror of the Go lib's known_to_atum_v2_test.go.
//
// known-to-atum-v2 exists because v1 is @protected and defines only the
// settler, psp and atumOperatedService roles. A role value v1 does not define
// expands to a relative IRI, which URDNA2015 leaves out of the canonical
// N-Quads, so the signature on such a credential does not cover its role.
// v2 adds quoteAwarder and merchant and keeps every v1 term unchanged.

import { describe, it, expect } from "vitest";

import {
  newDocumentLoader,
  W3C_VC_V1_CONTEXT_URL,
  KNOWN_TO_ATUM_V1_CONTEXT_URL,
  KNOWN_TO_ATUM_V2_CONTEXT_URL,
} from "./documentLoader.js";
import { canonicalize } from "./canonicalize.js";

const KTA_VOCABULARY = "https://schemas.atum.xyz/credentials/known-to-atum/v1#";

function contextTerms(url: string): Record<string, unknown> {
  const doc = newDocumentLoader().load(url) as Record<string, unknown>;
  return doc["@context"] as Record<string, unknown>;
}

function credential(contextUrl: string, role: string): Record<string, unknown> {
  return {
    "@context": [W3C_VC_V1_CONTEXT_URL, contextUrl],
    id: `urn:uuid:known-to-atum-v2-${role}`,
    type: ["VerifiableCredential", "KnownToAtumVerifiableCredential"],
    issuer: "did:web:atumlabs.xyz",
    issuanceDate: "2026-01-01T00:00:00Z",
    expirationDate: "2026-03-02T00:00:00Z",
    credentialSubject: {
      id: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      role,
    },
  };
}

describe("known-to-atum v2", () => {
  it("is served from schemas.atum.xyz", () => {
    expect(KNOWN_TO_ATUM_V2_CONTEXT_URL).toBe(
      "https://schemas.atum.xyz/credentials/known-to-atum/v2",
    );
  });

  // v2 may only add terms. Every v1 term must be defined exactly as v1
  // defines it, the kta prefix included, and the only new terms are the two
  // roles.
  it("keeps every v1 term and adds only quoteAwarder and merchant", () => {
    const v1 = contextTerms(KNOWN_TO_ATUM_V1_CONTEXT_URL);
    const v2 = contextTerms(KNOWN_TO_ATUM_V2_CONTEXT_URL);
    for (const [term, def] of Object.entries(v1)) {
      expect(v2, `v2 drops v1's term ${term}`).toHaveProperty([term]);
      expect(v2[term], `v2 redefines ${term}`).toEqual(def);
    }
    const added = Object.keys(v2)
      .filter((term) => !(term in v1))
      .sort();
    expect(added).toEqual(["merchant", "quoteAwarder"]);
    expect(v2.merchant).toBe("kta:merchant");
    expect(v2.quoteAwarder).toBe("kta:quoteAwarder");
  });

  // What a signature covers. Under v2 every role is in the canonical
  // N-Quads. Under v1 the two roles v1 does not define are not, which is why
  // they are issued under v2.
  const cases: Array<{ role: string; definedV1: boolean }> = [
    { role: "settler", definedV1: true },
    { role: "psp", definedV1: true },
    { role: "atumOperatedService", definedV1: true },
    { role: "quoteAwarder", definedV1: false },
    { role: "merchant", definedV1: false },
  ];
  for (const { role, definedV1 } of cases) {
    it(`puts the ${role} role in the signed N-Quads under v2`, async () => {
      const loader = newDocumentLoader();
      const v2 = await canonicalize(credential(KNOWN_TO_ATUM_V2_CONTEXT_URL, role), loader);
      expect(v2).toContain(`<${KTA_VOCABULARY}role> <${KTA_VOCABULARY}${role}> `);

      const v1 = await canonicalize(credential(KNOWN_TO_ATUM_V1_CONTEXT_URL, role), loader);
      expect(v1.includes(`<${KTA_VOCABULARY}role> `)).toBe(definedV1);
      if (definedV1) {
        expect(v1, `a ${role} credential signs different N-Quads under v1 and v2`).toBe(v2);
      }
    });
  }
});
