// Mirror of the Go lib's credential_contexts_test.go.
//
// The three credential contexts moved off schemas.atum.network to
// schemas.atum.xyz. Both halves of each context moved: the URL a credential
// names in its @context, and the vocabulary that context
// expands the credential's terms to (the kta:, kyc: and sc: prefixes). The
// vocabulary is the half a signature covers. URDNA2015 writes term IRIs into
// the canonical N-Quads and never a context URL, so moving only the URL would
// have left every signature byte-identical and the vocabulary where it was.
//
// The move is a hard cut. The retired URLs are not kept as aliases: a
// credential that still names one is refused as an unknown context, exactly
// like any other URL the loader does not hold.

import { describe, it, expect } from "vitest";

import {
  newDocumentLoader,
  W3C_VC_V1_CONTEXT_URL,
  KNOWN_TO_ATUM_V1_CONTEXT_URL,
  KYC_V1_CONTEXT_URL,
  SENDER_COMPLIANCE_V1_CONTEXT_URL,
} from "./documentLoader.js";
import { canonicalize } from "./canonicalize.js";
import { AdmissionError } from "./admission.js";
import { UnknownContextError } from "./errors.js";

interface CredentialContext {
  name: string;
  // The exported constant under test, and the value it must hold. Separate so
  // a test can fail on the constant itself.
  url: string;
  current: string;
  retired: string;
  // The term prefix the context defines; it must expand to current + "#".
  prefix: string;
  typeTerm: string;
  // A credentialSubject making one claim, both of whose terms are in the
  // context's vocabulary.
  subject: Record<string, string>;
  claimTerm: string;
  claimValue: string;
}

const SUBJECT_ID = "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const CREDENTIAL_CONTEXTS: CredentialContext[] = [
  {
    name: "known-to-atum",
    url: KNOWN_TO_ATUM_V1_CONTEXT_URL,
    current: "https://schemas.atum.xyz/credentials/known-to-atum/v1",
    retired: "https://schemas.atum.network/credentials/known-to-atum/v1",
    prefix: "kta",
    typeTerm: "KnownToAtumVerifiableCredential",
    subject: { id: SUBJECT_ID, role: "settler" },
    claimTerm: "role",
    claimValue: "settler",
  },
  {
    name: "kyc",
    url: KYC_V1_CONTEXT_URL,
    current: "https://schemas.atum.xyz/credentials/kyc/v1",
    retired: "https://schemas.atum.network/credentials/kyc/v1",
    prefix: "kyc",
    typeTerm: "KYCCredential",
    subject: { id: SUBJECT_ID, kycStatus: "approved" },
    claimTerm: "kycStatus",
    claimValue: "approved",
  },
  {
    name: "sender-compliance",
    url: SENDER_COMPLIANCE_V1_CONTEXT_URL,
    current: "https://schemas.atum.xyz/credentials/sender-compliance/v1",
    retired: "https://schemas.atum.network/credentials/sender-compliance/v1",
    prefix: "sc",
    typeTerm: "SenderComplianceCredential",
    subject: { id: SUBJECT_ID, complianceStatus: "approved" },
    claimTerm: "complianceStatus",
    claimValue: "approved",
  },
];

function credential(c: CredentialContext, contextUrl: string): Record<string, unknown> {
  return {
    "@context": [W3C_VC_V1_CONTEXT_URL, contextUrl],
    id: `urn:uuid:credential-contexts-${c.name}`,
    type: ["VerifiableCredential", c.typeTerm],
    issuer: "did:web:atumlabs.xyz",
    issuanceDate: "2026-01-01T00:00:00Z",
    credentialSubject: { ...c.subject },
  };
}

describe("credential contexts", () => {
  for (const c of CREDENTIAL_CONTEXTS) {
    describe(c.name, () => {
      it("is served from schemas.atum.xyz", () => {
        expect(c.url).toBe(c.current);
      });

      // The guard against moving only the URL: the vocabulary must live under
      // the context's own URL, so the two cannot be split apart unnoticed.
      it("defines its vocabulary under its own URL", () => {
        const doc = newDocumentLoader().load(c.current) as Record<string, unknown>;
        const terms = doc["@context"] as Record<string, unknown>;
        expect(terms[c.prefix]).toBe(`${c.current}#`);
      });

      // What a signature actually covers.
      it("canonicalizes every term to an IRI under schemas.atum.xyz", async () => {
        const nquads = await canonicalize(credential(c, c.current), newDocumentLoader());
        const vocab = `${c.current}#`;
        expect(nquads).toContain(
          `<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${vocab}${c.typeTerm}> `
        );
        expect(nquads).toContain(`<${vocab}${c.claimTerm}> <${vocab}${c.claimValue}> `);
        expect(nquads).not.toContain("atum.network");
      });

      it("refuses the retired schemas.atum.network URL as an unknown context", async () => {
        const loader = newDocumentLoader();
        expect(() => loader.load(c.retired)).toThrow(UnknownContextError);

        let caught: unknown;
        try {
          await canonicalize(credential(c, c.retired), loader);
        } catch (err) {
          caught = err;
        }
        expect(caught, "canonicalize accepted the retired URL").toBeDefined();
        expect(caught).not.toBeInstanceOf(AdmissionError);
        expect(caught).toBeInstanceOf(UnknownContextError);
        expect((caught as UnknownContextError).url).toBe(c.retired);
      });
    });
  }
});
