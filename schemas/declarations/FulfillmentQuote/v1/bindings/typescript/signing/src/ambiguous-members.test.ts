// A document that names a member twice, exactly or under the case folding Go's
// encoding/json applies, is refused before anything reads it, as Go's VerifyVP
// and VerifyVCProof refuse it (ambiguous_members_test.go). Both verifiers then
// keep one verdict for the same bytes.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyVP, type VerifyVPOptions } from "./verify-vp.js";
import { verifyVCProof, VPVCProofError, type IssuerKeyResolver } from "./verify-vc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  resolve(__dirname, "../../../../conformance/fixtures/secp256k1-go-vp.json"),
  "utf-8"
);
const HOLDER = "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

function options(): VerifyVPOptions {
  return {
    expectedChallenge: "req-fixture-1",
    expectedDomain: "did:web:settler.atum.network",
    expectedHolder: HOLDER,
    now: new Date("2026-04-01T00:00:30Z"),
    maxProofAgeMs: 60 * 60 * 1000,
    maxFutureSkewMs: 60 * 60 * 1000,
  };
}

// Inserts `,member` right after the one occurrence of anchor.
function withMemberAfter(raw: string, anchor: string, member: string): string {
  const n = raw.split(anchor).length - 1;
  if (n !== 1) {
    throw new Error(`anchor ${anchor} occurs ${n} times in the fixture, want exactly once`);
  }
  return raw.replace(anchor, `${anchor},${member}`);
}

const SUBJECT = `"credentialSubject":{"id":"${HOLDER}","role":"settler"}`;
const VC_TYPE = `"type":["VerifiableCredential","KnownToAtumVerifiableCredential"]`;

describe("verifyVP refuses a member named twice", () => {
  it("verifies the fixture as signed", async () => {
    const res = await verifyVP(fixture, options());
    expect(res.holder).toBe(HOLDER);
  });

  for (const [name, anchor, twin] of [
    ["a credential's type, capitalised", VC_TYPE, `"Type":["VerifiableCredential"]`],
    [
      "a credential's credentialSubject, spelled with U+017F, which folds to s",
      SUBJECT,
      `"credentialſubject":{"id":"${HOLDER}","role":"settler"}`,
    ],
    ["the presentation's holder, exactly", `"holder":"${HOLDER}"`, `"holder":"${HOLDER}"`],
  ] as const) {
    it(name, async () => {
      await expect(verifyVP(withMemberAfter(fixture, anchor, twin), options())).rejects.toThrow(
        /names a member twice/
      );
    });
  }

  it("an envelope passed as an object, with holder and Holder", async () => {
    const doc = { ...(JSON.parse(fixture) as Record<string, unknown>), Holder: HOLDER };
    await expect(verifyVP(doc, options())).rejects.toThrow(/names a member twice/);
  });
});

describe("verifyVCProof refuses a member named twice", () => {
  it("a credential with issuer and Issuer", async () => {
    const vc = (JSON.parse(fixture) as { verifiableCredential: Record<string, unknown>[] })
      .verifiableCredential[0];
    const resolver: IssuerKeyResolver = {
      resolve: async () => {
        throw new Error("the resolver must not be reached");
      },
    } as unknown as IssuerKeyResolver;
    const err = await verifyVCProof({ ...vc, Issuer: "did:web:elsewhere.example" }, resolver).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(VPVCProofError);
    expect((err as VPVCProofError).reason).toBe("ambiguousMember");
  });
});
