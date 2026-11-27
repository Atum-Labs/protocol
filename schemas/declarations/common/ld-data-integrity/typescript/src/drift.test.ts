import { describe, it, expect } from "vitest";

import { canonicalize } from "./canonicalize.js";
import {
  newDocumentLoader,
  W3C_VC_V1_CONTEXT_URL,
  KNOWN_TO_ATUM_V1_CONTEXT_URL,
  w3cVCv1FullVendoredSnapshot,
} from "./documentLoader.js";

// Mirror of the Go data-integrity library's
// TestW3CVCv1MinimalTwinMatchesFull. Canonicalizing a representative
// MVP VC under the inline minimal twin (the active resolver entry)
// MUST produce byte-identical n-quads to canonicalizing under the
// full vendored W3C VC v1 snapshot.
//
// If this test fails, EITHER the minimal twin is missing a term used
// by the test VC (fix the twin in documentLoader.ts) OR the full
// snapshot changed (re-vendor + re-confirm the twin still covers
// prod usage).
describe("W3C VC v1 inline twin matches full vendored snapshot", () => {
  it("produces byte-identical n-quads for an MVP KnownToAtumVerifiableCredential with forward-compatible terms", async () => {
    // Fixture covers the MVP shape plus the union of W3C VC v1
    // optional terms a future consumer might add (credentialSchema,
    // credentialStatus, evidence, expirationDate, validFrom,
    // validUntil, refreshService, termsOfUse, issued). Each new
    // term added to the twin in documentLoader.ts MUST appear
    // here; conversely, a future term needed by any consumer MUST
    // be added to both the twin and this fixture before production
    // canonicalization can rely on it.
    const vc = {
      "@context": [W3C_VC_V1_CONTEXT_URL, KNOWN_TO_ATUM_V1_CONTEXT_URL],
      id: "urn:uuid:00000000-0000-0000-0000-000000000001",
      type: ["VerifiableCredential", "KnownToAtumVerifiableCredential"],
      issuer: "did:web:atumlabs.xyz",
      issuanceDate: "2026-01-01T00:00:00Z",
      expirationDate: "2027-01-01T00:00:00Z",
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2027-01-01T00:00:00Z",
      issued: "2026-01-01T00:00:00Z",
      // URI-string values; object-shape would require binding the
      // nested @context in the twin too (out of scope until needed).
      credentialSchema: "https://schemas.atum.network/schema/known-to-atum/v1",
      credentialStatus: "urn:status:active",
      evidence: "urn:evidence:none",
      refreshService: "https://refresh.atumlabs.xyz/v1",
      termsOfUse: "https://terms.atumlabs.xyz/v1",
      credentialSubject: {
        id: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        role: "settler",
      },
    };

    const twinLoader = newDocumentLoader();
    const twinNQuads = await canonicalize(vc, twinLoader);

    const fullLoader = newDocumentLoader({
      [W3C_VC_V1_CONTEXT_URL]: w3cVCv1FullVendoredSnapshot(),
    });
    const fullNQuads = await canonicalize(vc, fullLoader);

    expect(twinNQuads).toEqual(fullNQuads);
  });
});
