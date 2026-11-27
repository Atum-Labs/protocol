// Reserved and pass-through credentials (VerifyVPOptions.reservedVCTypes).
// Mirror of the Go canonical's verify_vp_reserved_test.go.
//
// A presentation carries credentials to counterparties, who decide whom
// they trust as an issuer. Only reserved types (reservedVCTypes together
// with requiredVCTypes) are gated on the verifier's trusted issuers; any
// other credential is passed through untouched and returned in
// passThroughClaims.
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { SigningKey, Wallet } from "ethers";

import { KNOWN_TO_ATUM_V1_CONTEXT_URL, W3C_VC_V1_CONTEXT_URL } from "@atum-labs/ld-data-integrity";

import { signVCProofSecp256k1 } from "./sign-vc.js";
import { signVP } from "./sign-vp.js";
import type { IssuerKeyResolver, VerificationMethodSet } from "./verify-vc.js";
import { verifyVP, type VerifyVPOptions } from "./verify-vp.js";
import type { VerifiableCredential } from "@atum-labs/schema-declarations/FulfillmentQuoteEnvelope/v1/bindings/typescript";

const FIXTURE_NOW = new Date("2026-05-20T00:00:30.000Z");
const FIXTURE_CREATED = "2026-05-20T00:00:00.000Z";
const FIXTURE_CHALLENGE = "req-fixture-1";
const FIXTURE_DOMAIN = "did:web:settler.atum.network";

const TRUSTED_ISSUER = "did:web:atumlabs.test";
const THIRD_PARTY_ISSUER = "did:web:unlisted-issuer.example";
// An absolute IRI, so the type resolves under any context. A short name no
// loaded context defines can't be resolved and is checked, not passed
// through (see the spelling cases below).
const THIRD_PARTY_TYPE = "https://example.org/credentials#PartnerAttestationCredential";
const KTA_TYPE_IRI = "https://schemas.atum.xyz/credentials/known-to-atum/v1#KnownToAtumVerifiableCredential";
const IMPOSTOR = "did:web:impersonator.example";
const KTA = "KnownToAtumVerifiableCredential";

function credentialId(seed: string): string {
  const b = createHash("sha256").update(seed).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A Known-to-Atum credential about `subject`, signed by `issuerKey` under
// `issuer`, with the resolver-side key set for that issuer.
async function signedKnownToAtumVC(
  issuerKey: string,
  issuer: string,
  subject: string
): Promise<{ vc: Record<string, unknown>; vmSet: VerificationMethodSet }> {
  const body: Record<string, unknown> = {
    "@context": [W3C_VC_V1_CONTEXT_URL, KNOWN_TO_ATUM_V1_CONTEXT_URL],
    id: credentialId(`kta:${issuer}:${subject}`),
    type: ["VerifiableCredential", KTA],
    issuer,
    issuanceDate: "2026-01-01T00:00:00Z",
    credentialSubject: { id: subject, role: "settler" },
  };
  const vc = await signVCProofSecp256k1(body, issuerKey, {
    verificationMethod: `${issuer}#issuer-key-1`,
    proofPurpose: "assertionMethod",
    created: "2026-01-01T00:00:00Z",
  });
  const pub = new SigningKey(issuerKey).publicKey.slice(4); // drop 0x04
  const vmSet: VerificationMethodSet = [
    {
      id: `${issuer}#issuer-key-1`,
      type: "JsonWebKey2020",
      publicKeyJwk: {
        kty: "EC",
        crv: "secp256k1",
        x: Buffer.from(pub.slice(0, 64), "hex").toString("base64url"),
        y: Buffer.from(pub.slice(64), "hex").toString("base64url"),
      },
    },
  ];
  return { vc, vmSet };
}

// A credential from an issuer that isn't trusted and can't be resolved,
// deliberately invalid by every per-VC check: it expired before the fixture
// clock, and its subject is another account. Its proof is a stub no resolver
// could verify.
function thirdPartyVC(types: string[]): Record<string, unknown> {
  const id = credentialId(`third:${types.join(",")}`);
  return {
    "@context": [W3C_VC_V1_CONTEXT_URL, KNOWN_TO_ATUM_V1_CONTEXT_URL],
    id,
    type: types,
    issuer: THIRD_PARTY_ISSUER,
    issuanceDate: "2026-01-01T00:00:00Z",
    expirationDate: "2026-02-01T00:00:00Z",
    credentialSubject: { id: "did:pkh:eip155:1:0xdeadbeef00000000000000000000000000000002", role: "partner" },
    proof: {
      type: "EcdsaSecp256k1RecoverySignature2020",
      created: "2026-01-01T00:00:00Z",
      verificationMethod: `${THIRD_PARTY_ISSUER}#key-1`,
      proofPurpose: "assertionMethod",
      jws: `stub-signature-of:${id}`,
    },
  };
}

// A credential from `issuer` about `subject`, valid by date, with the given
// @context and types. Its proof is a stub: the spelling cases don't supply
// verifyVCProofs, so only the policy checks decide.
function spelledVC(issuer: string, subject: string, context: unknown[], types: string[]): Record<string, unknown> {
  const id = credentialId(`spelled:${issuer}:${JSON.stringify(context)}:${types.join(",")}`);
  return {
    "@context": context,
    id,
    type: types,
    issuer,
    issuanceDate: "2026-01-01T00:00:00Z",
    credentialSubject: { id: subject, role: "settler" },
    proof: {
      type: "EcdsaSecp256k1RecoverySignature2020",
      created: "2026-01-01T00:00:00Z",
      verificationMethod: `${issuer}#key-1`,
      proofPurpose: "assertionMethod",
      jws: `stub-signature-of:${id}`,
    },
  };
}

// Resolves only the trusted issuer and fails the test the moment any other
// issuer reaches it: a pass-through credential's issuer must never be
// resolved.
class GuardResolver implements IssuerKeyResolver {
  constructor(private readonly vmSet: VerificationMethodSet) {}
  async resolve(issuerDID: string): Promise<VerificationMethodSet> {
    if (issuerDID !== TRUSTED_ISSUER) {
      throw new Error(`issuer ${issuerDID} reached the resolver; a pass-through credential must never be resolved`);
    }
    return this.vmSet;
  }
}

async function signPresentation(wallet: { privateKey: string }, holder: string, vcs: Record<string, unknown>[]) {
  const signed = await signVP(vcs as unknown as VerifiableCredential[], wallet.privateKey, {
    holder,
    verificationMethod: `${holder}#blockchainAccountId`,
    challenge: FIXTURE_CHALLENGE,
    domain: FIXTURE_DOMAIN,
    created: FIXTURE_CREATED,
  });
  return signed as unknown as Record<string, unknown>;
}

function strictOpts(holder: string, extra: Partial<VerifyVPOptions> = {}): VerifyVPOptions {
  return {
    expectedChallenge: FIXTURE_CHALLENGE,
    expectedDomain: FIXTURE_DOMAIN,
    expectedHolder: holder,
    now: FIXTURE_NOW,
    maxProofAgeMs: 5 * 60 * 1000,
    maxFutureSkewMs: 30 * 1000,
    requiredVCTypes: [KTA],
    isIssuerTrusted: (d: string) => ({ allowed: d === TRUSTED_ISSUER, enforced: true }),
    ...extra,
  };
}

function newHolder() {
  const wallet = Wallet.createRandom();
  return { wallet, holder: `did:pkh:eip155:1:${wallet.address.toLowerCase()}` };
}

const ISSUER_KEY = Wallet.createRandom().privateKey;

describe("verifyVP: reserved and pass-through credentials", () => {
  it("passes an unreserved third-party credential through unchecked, under strict trust with VC proofs wired", async () => {
    const { wallet, holder } = newHolder();
    const { vc: kta, vmSet } = await signedKnownToAtumVC(ISSUER_KEY, TRUSTED_ISSUER, holder);
    const third = thirdPartyVC(["VerifiableCredential", THIRD_PARTY_TYPE]);
    const signed = await signPresentation(wallet, holder, [kta, third]);

    const res = await verifyVP(signed, strictOpts(holder, { verifyVCProofs: new GuardResolver(vmSet) }));
    const wire = signed.verifiableCredential as unknown[];
    expect(res.attestedClaims).toEqual([wire[0]]);
    expect(res.passThroughClaims).toEqual([wire[1]]);
    expect(res.vcProofsVerifiedCount).toBe(1);
  });

  it("refuses a reserved credential from an issuer outside the trust list (the impersonator)", async () => {
    const { wallet, holder } = newHolder();
    const { vc: forged } = await signedKnownToAtumVC(Wallet.createRandom().privateKey, "did:web:impersonator.example", holder);
    const signed = await signPresentation(wallet, holder, [forged]);
    await expect(verifyVP(signed, strictOpts(holder))).rejects.toThrow(/not in trust anchors|issuer.*not trusted/i);
  });

  it("does not let a pass-through credential satisfy requiredVCTypes", async () => {
    const { wallet, holder } = newHolder();
    const signed = await signPresentation(wallet, holder, [thirdPartyVC(["VerifiableCredential", THIRD_PARTY_TYPE])]);
    await expect(verifyVP(signed, strictOpts(holder))).rejects.toThrow(/no VC declared all requiredVCTypes/);
  });

  it("checks a credential whose type is listed in reservedVCTypes, even when only Known-to-Atum is required", async () => {
    const { wallet, holder } = newHolder();
    const { vc: kta, vmSet } = await signedKnownToAtumVC(ISSUER_KEY, TRUSTED_ISSUER, holder);
    const third = thirdPartyVC(["VerifiableCredential", THIRD_PARTY_TYPE]);
    const signed = await signPresentation(wallet, holder, [kta, third]);
    await expect(
      verifyVP(signed, strictOpts(holder, { reservedVCTypes: [THIRD_PARTY_TYPE], verifyVCProofs: new GuardResolverAllowingAny(vmSet) }))
    ).rejects.toThrow(/verifiableCredential\[1\]/);
  });

  it("checks every credential when neither reservedVCTypes nor requiredVCTypes is set", async () => {
    const { wallet, holder } = newHolder();
    const { vc: kta } = await signedKnownToAtumVC(ISSUER_KEY, TRUSTED_ISSUER, holder);
    const third = thirdPartyVC(["VerifiableCredential", THIRD_PARTY_TYPE]);
    const signed = await signPresentation(wallet, holder, [kta, third]);
    await expect(verifyVP(signed, strictOpts(holder, { requiredVCTypes: undefined }))).rejects.toThrow(
      /verifiableCredential\[1\]/
    );
  });

  it("checks a third-party credential that declares a reserved type among its own", async () => {
    const { wallet, holder } = newHolder();
    const { vc: kta } = await signedKnownToAtumVC(ISSUER_KEY, TRUSTED_ISSUER, holder);
    const smuggled = thirdPartyVC(["VerifiableCredential", THIRD_PARTY_TYPE, KTA]);
    const signed = await signPresentation(wallet, holder, [kta, smuggled]);
    await expect(verifyVP(signed, strictOpts(holder))).rejects.toThrow(/verifiableCredential\[1\]/);
  });

  // The reserved set is reservedVCTypes together with requiredVCTypes:
  // listing another type keeps the required type reserved, so a Known-to-Atum
  // credential from an issuer outside the trust list beside Atum's is still
  // checked and refused. Mirror of Go
  // TestVerifyVP_ReservedVCTypesKeepsRequiredTypesReserved.
  it("keeps the required type reserved when reservedVCTypes lists another", async () => {
    const { wallet, holder } = newHolder();
    const { vc: kta } = await signedKnownToAtumVC(ISSUER_KEY, TRUSTED_ISSUER, holder);
    const foreign = spelledVC(IMPOSTOR, holder, [W3C_VC_V1_CONTEXT_URL, KNOWN_TO_ATUM_V1_CONTEXT_URL], [
      "VerifiableCredential",
      KTA,
    ]);
    const signed = await signPresentation(wallet, holder, [kta, foreign]);
    await expect(verifyVP(signed, strictOpts(holder, { reservedVCTypes: [THIRD_PARTY_TYPE] }))).rejects.toThrow(
      /verifiableCredential\[1\] issuer .* not in trust anchors/
    );
  });

  // passThroughClaims returns the credential the envelope carried, the same
  // object, never a copy or a re-parse.
  it("returns the very credential object it passed through", async () => {
    const { wallet, holder } = newHolder();
    const { vc: kta, vmSet } = await signedKnownToAtumVC(ISSUER_KEY, TRUSTED_ISSUER, holder);
    const signed = await signPresentation(wallet, holder, [kta, thirdPartyVC(["VerifiableCredential", THIRD_PARTY_TYPE])]);
    const res = await verifyVP(signed, strictOpts(holder, { verifyVCProofs: new GuardResolver(vmSet) }));
    expect(res.passThroughClaims).toHaveLength(1);
    expect(res.passThroughClaims[0]).toBe((signed.verifiableCredential as unknown[])[1]);
  });

  // Only a plain object whose `type` is an array of strings can pass through.
  // Go refuses any other shape while decoding the envelope; here it walks
  // every check, so a bare-string reserved type from an untrusted issuer is
  // refused on its issuer, and a non-object entry on its missing subject.
  it("checks a credential whose type is a bare string, as Go refuses it", async () => {
    const { wallet, holder } = newHolder();
    const { vc: kta } = await signedKnownToAtumVC(ISSUER_KEY, TRUSTED_ISSUER, holder);
    const bare = { ...spelledVC(IMPOSTOR, holder, [W3C_VC_V1_CONTEXT_URL, KNOWN_TO_ATUM_V1_CONTEXT_URL], []), type: KTA };
    const signed = await signPresentation(wallet, holder, [kta, bare]);
    await expect(verifyVP(signed, strictOpts(holder))).rejects.toThrow(
      /verifiableCredential\[1\] issuer .* not in trust anchors/
    );
  });

  it("checks an entry that isn't a credential object", async () => {
    const { wallet, holder } = newHolder();
    const { vc: kta } = await signedKnownToAtumVC(ISSUER_KEY, TRUSTED_ISSUER, holder);
    const signed = await signPresentation(wallet, holder, [kta, "urn:example:junk" as unknown as Record<string, unknown>]);
    await expect(verifyVP(signed, strictOpts(holder))).rejects.toThrow(/verifiableCredential\[1\]/);
  });

  // Every JSON-LD spelling of the reserved type, and a type nothing defines,
  // is checked: from an issuer outside the trust list it refuses the
  // presentation under strict trust. Trusting that issuer as well makes the
  // same presentation verify with the credential in attestedClaims, so the
  // refusal came from the issuer check on a checked credential. Mirror of Go
  // TestVerifyVP_ReservedTypeSpellings_AreChecked.
  const spellings: [string, unknown[], string[]][] = [
    ["the full IRI", [W3C_VC_V1_CONTEXT_URL, KNOWN_TO_ATUM_V1_CONTEXT_URL], ["VerifiableCredential", KTA_TYPE_IRI]],
    [
      "the kta: compact form",
      [W3C_VC_V1_CONTEXT_URL, KNOWN_TO_ATUM_V1_CONTEXT_URL],
      ["VerifiableCredential", "kta:KnownToAtumVerifiableCredential"],
    ],
    [
      "the kta: form without the known-to-atum context",
      [W3C_VC_V1_CONTEXT_URL],
      ["VerifiableCredential", "kta:KnownToAtumVerifiableCredential"],
    ],
    [
      "a short name no context defines",
      [W3C_VC_V1_CONTEXT_URL, KNOWN_TO_ATUM_V1_CONTEXT_URL],
      ["VerifiableCredential", "PartnerAttestationCredential"],
    ],
  ];
  for (const [name, context, types] of spellings) {
    it(`checks a reserved type spelled as ${name}`, async () => {
      const { wallet, holder } = newHolder();
      const { vc: kta } = await signedKnownToAtumVC(ISSUER_KEY, TRUSTED_ISSUER, holder);
      const spelled = spelledVC(IMPOSTOR, holder, context, types);
      const signed = await signPresentation(wallet, holder, [kta, spelled]);
      await expect(verifyVP(signed, strictOpts(holder))).rejects.toThrow(
        /verifiableCredential\[1\] issuer .* not in trust anchors/
      );
      const res = await verifyVP(
        signed,
        strictOpts(holder, { isIssuerTrusted: (d: string) => ({ allowed: d === TRUSTED_ISSUER || d === IMPOSTOR, enforced: true }) })
      );
      expect(res.attestedClaims).toHaveLength(2);
      expect(res.passThroughClaims).toHaveLength(0);
    });
  }
});

// Partner credentials under their own contexts (extraCredentialContexts).
// Mirror of the Go canonical's partner-context tests.
const PARTNER_CONTEXT_URL = "https://partner.example/credentials/v1";
const PARTNER_MEMBERSHIP_CONTEXT_URL = "https://partner.example/membership/v1";
const PARTNER_CONTEXT = {
  "@context": {
    "@version": 1.1,
    "@protected": true,
    pt: "https://partner.example/credentials/v1#",
    PartnerAttestationCredential: "pt:PartnerAttestationCredential",
    riskScore: "pt:riskScore",
  },
};
const PARTNER_MEMBERSHIP_CONTEXT = {
  "@context": { "@version": 1.1, PartnerMembershipCredential: KTA_TYPE_IRI },
};

function partnerVC(issuer: string, subject: string, ctxURL: string, type: string, expires: boolean): Record<string, unknown> {
  const vc: Record<string, unknown> = {
    "@context": [W3C_VC_V1_CONTEXT_URL, ctxURL],
    id: "urn:uuid:7f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
    type: ["VerifiableCredential", type],
    issuer,
    issuanceDate: "2026-01-02T00:00:00Z",
    credentialSubject: { id: subject, riskScore: "low" },
    proof: {
      type: "EcdsaSecp256k1RecoverySignature2020",
      created: "2026-01-02T00:00:00Z",
      verificationMethod: `${issuer}#key-1`,
      proofPurpose: "assertionMethod",
    },
  };
  if (expires) vc.expirationDate = "2026-02-01T00:00:00Z";
  return vc;
}

async function signWithContexts(
  wallet: { privateKey: string },
  holder: string,
  vcs: Record<string, unknown>[],
  contexts: Record<string, unknown>
) {
  const signed = await signVP(vcs as unknown as VerifiableCredential[], wallet.privateKey, {
    holder,
    verificationMethod: `${holder}#blockchainAccountId`,
    challenge: FIXTURE_CHALLENGE,
    domain: FIXTURE_DOMAIN,
    created: FIXTURE_CREATED,
    extraEnvelopeContexts: contexts,
  });
  return signed as unknown as Record<string, unknown>;
}

describe("verifyVP: partner credentials under their own contexts", () => {
  it("passes a partner credential through with its context supplied, and refuses the presentation without it", async () => {
    const { wallet, holder } = newHolder();
    const { vc: kta, vmSet } = await signedKnownToAtumVC(ISSUER_KEY, TRUSTED_ISSUER, holder);
    const partner = partnerVC(
      THIRD_PARTY_ISSUER,
      "did:pkh:eip155:1:0xdeadbeef00000000000000000000000000000002",
      PARTNER_CONTEXT_URL,
      "PartnerAttestationCredential",
      true
    );
    const contexts = { [PARTNER_CONTEXT_URL]: PARTNER_CONTEXT };
    const signed = await signWithContexts(wallet, holder, [kta, partner], contexts);

    const opts = strictOpts(holder, { verifyVCProofs: new GuardResolver(vmSet), extraCredentialContexts: contexts });
    const res = await verifyVP(signed, opts);
    expect(res.passThroughClaims).toEqual([(signed.verifiableCredential as unknown[])[1]]);

    await expect(verifyVP(signed, { ...opts, extraCredentialContexts: undefined })).rejects.toThrow();
  });

  it("checks a credential whose supplied context aliases the reserved type's IRI", async () => {
    const { wallet, holder } = newHolder();
    const { vc: kta } = await signedKnownToAtumVC(ISSUER_KEY, TRUSTED_ISSUER, holder);
    const aliased = partnerVC(IMPOSTOR, holder, PARTNER_MEMBERSHIP_CONTEXT_URL, "PartnerMembershipCredential", false);
    const contexts = { [PARTNER_MEMBERSHIP_CONTEXT_URL]: PARTNER_MEMBERSHIP_CONTEXT };
    const signed = await signWithContexts(wallet, holder, [kta, aliased], contexts);

    await expect(verifyVP(signed, strictOpts(holder, { extraCredentialContexts: contexts }))).rejects.toThrow(
      /verifiableCredential\[1\] issuer .* not in trust anchors/
    );
    const res = await verifyVP(
      signed,
      strictOpts(holder, {
        extraCredentialContexts: contexts,
        isIssuerTrusted: (d: string) => ({ allowed: d === TRUSTED_ISSUER || d === IMPOSTOR, enforced: true }),
      })
    );
    expect(res.attestedClaims).toHaveLength(2);
    expect(res.passThroughClaims).toHaveLength(0);
  });

  it("refuses a supplied context that would replace a bundled or envelope context", async () => {
    const { wallet, holder } = newHolder();
    const { vc: kta } = await signedKnownToAtumVC(ISSUER_KEY, TRUSTED_ISSUER, holder);
    const signed = await signPresentation(wallet, holder, [kta]);
    await expect(
      verifyVP(signed, strictOpts(holder, { extraCredentialContexts: { [KNOWN_TO_ATUM_V1_CONTEXT_URL]: PARTNER_MEMBERSHIP_CONTEXT } }))
    ).rejects.toThrow(/extraCredentialContexts: .* is a bundled context/);
    await expect(
      verifyVP(
        signed,
        strictOpts(holder, {
          extraEnvelopeContexts: { [PARTNER_CONTEXT_URL]: PARTNER_CONTEXT },
          extraCredentialContexts: { [PARTNER_CONTEXT_URL]: PARTNER_CONTEXT },
        })
      )
    ).rejects.toThrow(/extraCredentialContexts: .* is also an extraEnvelopeContexts key/);
    await expect(verifyVP(signed, strictOpts(holder))).resolves.toBeDefined();
  });
});

// For the explicitly reserved case the third-party credential is checked,
// so its issuer may reach the resolver; it fails on its subject or dates
// before that, but the resolver must not abort the test if it is asked.
class GuardResolverAllowingAny implements IssuerKeyResolver {
  constructor(private readonly vmSet: VerificationMethodSet) {}
  async resolve(issuerDID: string): Promise<VerificationMethodSet> {
    if (issuerDID !== TRUSTED_ISSUER) throw new Error(`unknown issuer ${issuerDID}`);
    return this.vmSet;
  }
}

