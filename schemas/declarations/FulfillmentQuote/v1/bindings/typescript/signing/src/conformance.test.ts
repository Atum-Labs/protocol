// Cross-language conformance for the FulfillmentQuote/v1 LD signing
// libraries. Mirror of conformance_test.go in the Go ld-verification
// package — together they pin:
//
//  1. TS verifies Go-signed quotes under both cryptosuites.
//  2. Go verifies TS-signed quotes — covered by the Go conformance_test.go.
//  3. Ed25519 fixtures are byte-identical across languages (RFC 8032
//     determinism). Tested on both sides so neither generator can
//     drift without the other catching it.
//
// Fixtures live at schemas/declarations/FulfillmentQuote/v1/conformance/fixtures/
// — regenerated via the two language-specific generators (see the
// conformance/ README for the regen flow).

import { describe, it, expect } from "vitest";
import {
  KNOWN_TO_ATUM_V1_CONTEXT_URL,
  W3C_VC_V1_CONTEXT_URL,
} from "@atum-labs/ld-data-integrity";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { verifyQuote } from "./verify.js";
import { computeQuoteHash } from "./quote-hash.js";
import { verifyVP, type VerifyVPOptions } from "./verify-vp.js";
import {
  verifyVCProof,
  VPVCProofError,
  type IssuerKeyResolver,
  type VerificationMethodSet,
} from "./verify-vc.js";
import { canonicalize } from "./canonicalize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Walk up out of src/ to the package dir, then up to the
// FulfillmentQuote/v1 directory, then down into conformance/fixtures.
const fixturesDir = resolve(__dirname, "../../../../conformance/fixtures");

function readFixture(name: string): Buffer {
  return readFileSync(resolve(fixturesDir, name));
}

// PaymentRequestEnvelope (PRE) declarationType-set bindings, mirror
// of the two generators' PRE consts + the canonical PRE binding. PRE_CONTEXT is
// the canonical declaration context, overlaid (extraEnvelopeContexts) so the
// verifier's strict loader resolves the PRE URL.
const PRE_CONTEXT_URL =
  "https://schemas.atum.network/declarations/PaymentRequestEnvelope/v1/context.jsonld";
const PRE_ENVELOPE_TYPE = "PaymentRequestEnvelope";
const PRE_CONTEXT = JSON.parse(
  readFileSync(
    resolve(
      fixturesDir,
      "../../../../PaymentRequestEnvelope/v1/context.jsonld"
    ),
    "utf-8"
  )
) as Record<string, unknown>;

// Hardhat account #0 — the well-known test key both generators pin
// as the secp256k1 signer. A drift here means a generator picked up a
// different key by accident.
const HARDHAT_ACCOUNT_0 = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

// RFC 8032 zero-seed ed25519 public key. The 32-byte all-zero seed
// produces a deterministic keypair whose pubkey hex is below; both
// generators derive their ed25519 signer from this seed for the same
// reasons (universal reproducibility, drift-resistance).
const RFC8032_ZERO_SEED_PUBKEY_HEX =
  "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";

// proof.created every signed fixture carries (conformance/README.md "Pinned
// inputs"); asserting it makes the contract "same signer AND same created".
// Midnight, so sub-second parsing is covered by the round-trip in verify.test.ts.
const FIXTURE_CREATED = "2026-04-01T00:00:00.000Z";

describe("conformance: TS verifies Go-signed", () => {
  it("secp256k1: recovers Hardhat account #0 from the Go-signed fixture", async () => {
    const signed = readFixture("secp256k1-go-signed.json");
    const result = await verifyQuote(signed.toString("utf-8"));
    expect(result.cryptosuite).toBe("EcdsaSecp256k1RecoverySignature2020");
    expect(result.signerAddress.toLowerCase()).toBe(HARDHAT_ACCOUNT_0);
    expect(result.created.toISOString()).toBe(FIXTURE_CREATED);
  });

  it("ed25519: recovers the RFC 8032 zero-seed pubkey from the Go-signed fixture", async () => {
    const signed = readFixture("ed25519-go-signed.json");
    const result = await verifyQuote(signed.toString("utf-8"));
    expect(result.cryptosuite).toBe("Ed25519Signature2020");
    expect(result.ed25519PublicKey).not.toBeNull();
    expect(Buffer.from(result.ed25519PublicKey!).toString("hex")).toBe(
      RFC8032_ZERO_SEED_PUBKEY_HEX
    );
    expect(result.didNetwork).toBe("devnet");
    expect(result.created.toISOString()).toBe(FIXTURE_CREATED);
  });
});

// Stronger pin than verify-each-other: the actual signed bytes must
// match between the Go and TS generators because ed25519 signatures are
// deterministic. A drift here means either the canonicalization, the
// hash composition, or the proof-block assembly has diverged silently
// in one of the two languages.
describe("conformance: ed25519 fixtures are byte-identical across languages", () => {
  it("ed25519-go-signed.json === ed25519-ts-signed.json", () => {
    const goSigned = readFixture("ed25519-go-signed.json");
    const tsSigned = readFixture("ed25519-ts-signed.json");
    expect(goSigned.equals(tsSigned)).toBe(true);
  });
});

// VP-side conformance — extends the FQ pattern above to the
// FulfillmentQuoteEnvelope shape: signVP on one side, verifyVP on the
// other, plus the deterministic-ed25519 byte-identity pin.

function vpHappyOpts(holder: string): VerifyVPOptions {
  return {
    expectedChallenge: "req-fixture-1",
    expectedDomain: "did:web:settler.atum.network",
    expectedHolder: holder,
    now: new Date("2026-04-01T00:00:30Z"),
    maxProofAgeMs: 60 * 60 * 1000,
    maxFutureSkewMs: 60 * 60 * 1000,
  };
}

describe("conformance: TS verifies Go-signed VP", () => {
  it("secp256k1: recovers Hardhat account #0 from the Go-signed VP fixture", async () => {
    const signed = readFixture("secp256k1-go-vp.json");
    const holder = `did:pkh:eip155:1:${HARDHAT_ACCOUNT_0}`;
    const res = await verifyVP(signed.toString("utf-8"), vpHappyOpts(holder));
    expect(res.cryptosuite).toBe("EcdsaSecp256k1RecoverySignature2020");
    expect(res.holder).toBe(holder);
    expect(res.signerAddress.toLowerCase()).toBe(HARDHAT_ACCOUNT_0);
    expect(res.attestedClaims).toHaveLength(1);
  });

  it("ed25519: recovers the RFC 8032 zero-seed pubkey from the Go-signed VP fixture", async () => {
    const signed = readFixture("ed25519-go-vp.json");
    // pubBase58 derived from the all-zero 32-byte seed.
    const holder =
      "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS";
    const res = await verifyVP(signed.toString("utf-8"), vpHappyOpts(holder));
    expect(res.cryptosuite).toBe("Ed25519Signature2020");
    expect(res.holder).toBe(holder);
    expect(res.ed25519PublicKey).not.toBeNull();
    expect(Buffer.from(res.ed25519PublicKey!).toString("hex")).toBe(
      RFC8032_ZERO_SEED_PUBKEY_HEX
    );
    expect(res.didNetwork).toBe("solana:devnet");
  });
});

// The production-realistic multi-type VC shape
// (`type: ["VerifiableCredential", "KnownToAtumVerifiableCredential"]` with the
// known-to-atum/v1 context URL alongside W3C VC v1) verifies AND
// produces byte-identical canonical n-quads across json-gold and
// jsonld.js. The conformance fixtures now embed this shape directly,
// so the byte-identity test below
// (`ed25519-go-vp.json === ed25519-ts-vp.json`) covers the
// canonicalization half; this block additionally exercises the
// verifyVP happy path with requiredVCTypes including the alias to
// pin that the type-policy gate doesn't drop it.
describe("conformance: VP ed25519 with KnownToAtumVerifiableCredential", () => {
  it("verifies under requiredVCTypes including the KnownToAtumVerifiableCredential alias", async () => {
    const signed = readFixture("ed25519-go-vp.json");
    const holder =
      "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS";
    const opts: VerifyVPOptions = {
      ...vpHappyOpts(holder),
      requiredVCTypes: [
        "VerifiableCredential",
        "KnownToAtumVerifiableCredential",
      ],
    };
    const res = await verifyVP(signed.toString("utf-8"), opts);
    expect(res.cryptosuite).toBe("Ed25519Signature2020");
    expect(res.holder).toBe(holder);
    expect(res.attestedClaims).toHaveLength(1);
  });
});

// VP byte-identity pin — the load-bearing determinism check for the
// envelope path. Mirror of the FQ-side ed25519 pin above. Drift here
// means the multi-context proof block assembly, keepVerifiableCredential
// strip behavior, or the VC array canonicalization disagreed silently
// across languages.
describe("conformance: ed25519 VP fixtures are byte-identical across languages", () => {
  it("ed25519-go-vp.json === ed25519-ts-vp.json", () => {
    const goSigned = readFixture("ed25519-go-vp.json");
    const tsSigned = readFixture("ed25519-ts-vp.json");
    expect(goSigned.equals(tsSigned)).toBe(true);
  });
});

// Negative VP fixtures: the envelopes above with the credential's
// issuanceDate set to JSON null. Each language signs a pair, and both
// verifiers must refuse all four. Mirror of conformance_test.go's
// TestConformance_VPNullIssuanceDateRefused. The holder signature over each
// envelope is valid, so the refusal comes from the credential check: verifyVP
// reads the credential's issuanceDate only after the signature and the
// signer/holder binding have passed.
describe("conformance: VP with a null credential issuanceDate is refused", () => {
  const holderSecp = `did:pkh:eip155:1:${HARDHAT_ACCOUNT_0}`;
  const holderEd =
    "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS";
  const fixtures: ReadonlyArray<readonly [string, string]> = [
    ["secp256k1-go-vp-null-issuance-date.json", holderSecp],
    ["secp256k1-ts-vp-null-issuance-date.json", holderSecp],
    ["ed25519-go-vp-null-issuance-date.json", holderEd],
    ["ed25519-ts-vp-null-issuance-date.json", holderEd],
  ];

  for (const [file, holder] of fixtures) {
    it(`${file}: verifyVP refuses the credential`, async () => {
      const text = readFixture(file).toString("utf-8");

      // The member must be on the wire and null. A generator that dropped it
      // would exercise the absent case instead. Here the check is
      // load-bearing: absent and null throw the same error.
      const vcs = (JSON.parse(text) as { verifiableCredential: Record<string, unknown>[] })
        .verifiableCredential;
      expect(vcs).toHaveLength(1);
      expect(Object.hasOwn(vcs[0], "issuanceDate")).toBe(true);
      expect(vcs[0].issuanceDate).toBeNull();

      await expect(verifyVP(text, vpHappyOpts(holder))).rejects.toThrow(
        /missing or non-string field "issuanceDate"/
      );
    });
  }

  it("ed25519-go-vp-null-issuance-date.json === ed25519-ts-vp-null-issuance-date.json", () => {
    const goSigned = readFixture("ed25519-go-vp-null-issuance-date.json");
    const tsSigned = readFixture("ed25519-ts-vp-null-issuance-date.json");
    expect(goSigned.equals(tsSigned)).toBe(true);
  });
});

// PRE-side conformance — the declarationType-set path. The
// fixtures are PaymentRequestEnvelopes (type
// ["VerifiablePresentation","PaymentRequestEnvelope"], signed under the PRE
// declaration @context). They exercise the envelope-context-overlay seam
// (verifyVP.envelopeContextUrl + extraEnvelopeContexts) and the
// declaration-type binding (expectedDeclarationType) on the TS verifier.
function vpHappyOptsPRE(holder: string): VerifyVPOptions {
  return {
    ...vpHappyOpts(holder),
    expectedDeclarationType: PRE_ENVELOPE_TYPE,
    envelopeContextUrl: PRE_CONTEXT_URL,
    extraEnvelopeContexts: { [PRE_CONTEXT_URL]: PRE_CONTEXT },
  };
}

describe("conformance: TS verifies Go-signed PRE VP", () => {
  it("secp256k1: recovers Hardhat account #0 from the Go-signed PRE fixture", async () => {
    const signed = readFixture("secp256k1-go-pre-vp.json");
    const holder = `did:pkh:eip155:1:${HARDHAT_ACCOUNT_0}`;
    const res = await verifyVP(
      signed.toString("utf-8"),
      vpHappyOptsPRE(holder)
    );
    expect(res.cryptosuite).toBe("EcdsaSecp256k1RecoverySignature2020");
    expect(res.holder).toBe(holder);
    expect(res.signerAddress.toLowerCase()).toBe(HARDHAT_ACCOUNT_0);
    expect(res.attestedClaims).toHaveLength(1);
  });

  // The typed holder proof a payer's wallet signs, by the Go signer: an EIP-712 signature over
  // PaymentRequestEnvelopeProof{proofHash, docHash}. Accepted where the verifier accepts that
  // form, refused where it doesn't.
  it("secp256k1 typed: recovers Hardhat account #0 where the typed form is accepted", async () => {
    const signed = readFixture("secp256k1-typed-go-pre-vp.json").toString("utf-8");
    const holder = `did:pkh:eip155:1:${HARDHAT_ACCOUNT_0}`;
    const res = await verifyVP(signed, { ...vpHappyOptsPRE(holder), acceptPaymentRequestEnvelopeTypedProof: true });
    expect(res.signerAddress.toLowerCase()).toBe(HARDHAT_ACCOUNT_0);
    expect(res.attestedClaims).toHaveLength(1);
    await expect(verifyVP(signed, vpHappyOptsPRE(holder))).rejects.toThrow();
  });

  it("ed25519: recovers the RFC 8032 zero-seed pubkey from the Go-signed PRE fixture", async () => {
    const signed = readFixture("ed25519-go-pre-vp.json");
    const holder =
      "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS";
    const res = await verifyVP(
      signed.toString("utf-8"),
      vpHappyOptsPRE(holder)
    );
    expect(res.cryptosuite).toBe("Ed25519Signature2020");
    expect(res.holder).toBe(holder);
    expect(Buffer.from(res.ed25519PublicKey!).toString("hex")).toBe(
      RFC8032_ZERO_SEED_PUBKEY_HEX
    );
    expect(res.didNetwork).toBe("solana:devnet");
  });

  // The security property the PRE seam exists for: a valid PRE signature must
  // still be REJECTED when the verifier expects a different declaration kind —
  // the type binding (covered by the rdf:type n-quad) is what stops a relabeled
  // envelope. The signature itself is valid; only the type assertion fails.
  it("rejects a PRE when expectedDeclarationType is the wrong kind", async () => {
    const signed = readFixture("secp256k1-go-pre-vp.json");
    const holder = `did:pkh:eip155:1:${HARDHAT_ACCOUNT_0}`;

    // First prove the SAME fixture verifies cleanly (signature + bindings)
    // under the CORRECT type. The declaration-type gate runs before crypto
    // dispatch, so without this the rejection below could be a false positive
    // (a corrupt fixture would "reject" for the wrong reason). Pinning the
    // positive case makes the type mismatch the sole accept/reject differentiator
    // — i.e. the "signature itself is valid" claim above is now backed by a check.
    const ok = await verifyVP(signed.toString("utf-8"), vpHappyOptsPRE(holder));
    expect(ok.cryptosuite).toBe("EcdsaSecp256k1RecoverySignature2020");

    const opts: VerifyVPOptions = {
      ...vpHappyOptsPRE(holder),
      expectedDeclarationType: "FulfillmentQuoteEnvelope",
    };
    await expect(verifyVP(signed.toString("utf-8"), opts)).rejects.toThrow(
      /declaration-type binding/
    );
  });

  // The case above rejects via the includes-gate when
  // expectedDeclarationType mismatches. This proves the STRONGER property — the
  // declaration type is bound UNDER the holder signature (an rdf:type n-quad),
  // not merely includes-gate-checked. Relabel doc.type to FulfillmentQuoteEnvelope
  // AND set expectedDeclarationType to match, so the includes-gate PASSES — then
  // assert the rejection is a SIGNATURE failure (the recovered signer no longer
  // matches the holder because the tampered type changed the signed bytes), NOT
  // the type gate.
  it("rejects a relabeled PRE on signature mismatch even when the includes-gate passes", async () => {
    const doc = JSON.parse(
      readFixture("secp256k1-go-pre-vp.json").toString("utf-8")
    ) as Record<string, unknown>;
    const holder = `did:pkh:eip155:1:${HARDHAT_ACCOUNT_0}`;

    doc.type = ["VerifiablePresentation", "FulfillmentQuoteEnvelope"];
    const opts: VerifyVPOptions = {
      ...vpHappyOptsPRE(holder),
      expectedDeclarationType: "FulfillmentQuoteEnvelope",
    };

    // Crypto rejection (recovered signer ≠ holder), not the includes-gate.
    await expect(verifyVP(JSON.stringify(doc), opts)).rejects.toThrow(
      /VP signer\/holder mismatch/
    );
  });
});

// PRE byte-identity pin — strongest cross-language proof for the
// declarationType-set path. Mirror of the FQE VP pin: the PRE envelope's
// ed25519 signature is RFC 8032 deterministic, so the declaration @context
// overlay + the PaymentRequestEnvelope rdf:type n-quad MUST canonicalize
// identically under json-gold and jsonld.js.
describe("conformance: ed25519 PRE VP fixtures are byte-identical across languages", () => {
  it("ed25519-go-pre-vp.json === ed25519-ts-pre-vp.json", () => {
    const goSigned = readFixture("ed25519-go-pre-vp.json");
    const tsSigned = readFixture("ed25519-ts-pre-vp.json");
    expect(goSigned.equals(tsSigned)).toBe(true);
  });
});

// VC-proof side conformance. Mirror of conformance_test.go's
// VC-proof block. The JWK sidecar (vc-issuer-{secp256k1,ed25519}.jwk.json,
// emitted only by the Go generator) is loaded as the mock resolver's
// published key set — both languages pin the same issuer keys so a
// single source of truth on the sidecar is sufficient.

function jwkSidecarResolver(sidecarFile: string): IssuerKeyResolver {
  const body = readFixture(sidecarFile).toString("utf-8");
  const parsed = JSON.parse(body) as {
    $comment?: string;
    vmSet: Array<{
      id: string;
      type: string;
      publicKeyJwk: Record<string, unknown>;
    }>;
  };
  const vmSet: VerificationMethodSet = parsed.vmSet.map((entry) => ({
    id: entry.id,
    type: entry.type,
    publicKeyJwk: entry.publicKeyJwk,
  }));
  return {
    resolve: async (_issuerDID: string) => vmSet,
  };
}

// SCOPE NOTE: the predicate list includes the
// atum-specific bindings — `kta:KnownToAtumVerifiableCredential`
// (the @type alias retired here for cross-language byte-identity) and
// `kta:role` (the production-emitted claim field on credentialSubject).
// The previous fixture-only placeholder `knownToAtum: true` is gone;
// the fixture matches what the production issuer actually emits.
//
// The known-to-atum context also carries a defensive `knownToAtum` binding (xsd:boolean)
// to the known-to-atum context — exercised separately by the
// "knownToAtum field binding" describe block below — so the canonical
// example the reviewer flagged is closed for any future producer that
// does start emitting the field.
describe("conformance: TS verifies Go-signed VC proof", () => {
  it("secp256k1: VC signed by Go verifies against the JWK sidecar resolver", async () => {
    const signed = readFixture("secp256k1-go-vc-proof.json").toString("utf-8");
    const vc = JSON.parse(signed) as Record<string, unknown>;
    const resolver = jwkSidecarResolver("vc-issuer-secp256k1.jwk.json");
    await expect(verifyVCProof(vc, resolver)).resolves.toBeUndefined();
    await assertVCNquadsBindLoadBearingTerms(vc, "secp256k1-go-vc-proof");
  });

  it("ed25519: VC signed by Go verifies against the JWK sidecar resolver", async () => {
    const signed = readFixture("ed25519-go-vc-proof.json").toString("utf-8");
    const vc = JSON.parse(signed) as Record<string, unknown>;
    const resolver = jwkSidecarResolver("vc-issuer-ed25519.jwk.json");
    await expect(verifyVCProof(vc, resolver)).resolves.toBeUndefined();
    await assertVCNquadsBindLoadBearingTerms(vc, "ed25519-go-vc-proof");
  });
});

// assertVCNquadsBindLoadBearingTerms canonicalizes a VC body (proof
// stripped) via the exported canonicalize and asserts that the load-
// bearing predicates the verifier counts on appear in the canonical
// n-quads. Mirror of Go's assertVCNquadsBindLoadBearingTerms in
// conformance_test.go; both sides MUST agree on which predicates count
// as load-bearing or one language could silently un-attest a claim the
// other still attests.
//
// Adds the orthogonal property
// "the load-bearing predicates were in the signed bytes" on top of the
// existing "the signature verifies" assertion. The list extends to
// the atum-specific bindings:
// `kta:KnownToAtumVerifiableCredential` (@type alias for cross-language
// byte-identity) and `kta:role` (the production-emitted claim field).
async function assertVCNquadsBindLoadBearingTerms(
  vc: Record<string, unknown>,
  fixtureLabel: string
): Promise<void> {
  const stripped = { ...vc };
  delete (stripped as Record<string, unknown>)["proof"];
  const nquads = await canonicalize(stripped);
  // Vitest doesn't have a per-test t.Logf equivalent; print on
  // failure only via expect.fail context. Always log to aid the
  // reviewer reading test output (matches the Go side's t.Logf).
  // eslint-disable-next-line no-console
  console.log(`${fixtureLabel} canonical n-quads (proof stripped):\n${nquads}`);
  const requiredPredicates = [
    // W3C VC v1 — load-bearing for ANY VC's identity.
    "<https://www.w3.org/2018/credentials#credentialSubject>",
    "<https://www.w3.org/2018/credentials#issuer>",
    "<https://www.w3.org/2018/credentials#issuanceDate>",
    // atum-specific bindings the issuer emits.
    "<https://schemas.atum.xyz/credentials/known-to-atum/v1#KnownToAtumVerifiableCredential>",
    "<https://schemas.atum.xyz/credentials/known-to-atum/v1#role>",
  ];
  for (const p of requiredPredicates) {
    expect(
      nquads,
      `${fixtureLabel} canonical n-quads missing required predicate ${p} — claim is in JSON but not in signed bytes:\n${nquads}`
    ).toContain(p);
  }
}

// Mirror of Go's TestKnownToAtumFieldBinding (conformance_test.go).
// Pins the defensive binding for the `knownToAtum` boolean field on the
// known-to-atum v1 context. Production credentials don't emit this
// field today (the fixture above carries `role: "settler"`, not
// `knownToAtum: true`); the field is bound defensively so a
// future issuer code change that DOES start emitting it won't have its
// claim silently dropped during URDNA2015 expansion.
//
// Both languages MUST agree on the binding — a Go-only or TS-only
// binding would produce different canonical n-quads cross-language
// and break ed25519 signature byte-identity. The synthetic VC body
// below matches the Go test's exactly; vary either and both must move
// together.
describe("knownToAtum field binding (defensive)", () => {
  it("kta:knownToAtum appears in canonical n-quads when a producer emits the field", async () => {
    const doc: Record<string, unknown> = {
      "@context": [
        W3C_VC_V1_CONTEXT_URL,
        KNOWN_TO_ATUM_V1_CONTEXT_URL,
      ],
      id: "urn:uuid:vc-knowntoatum-binding-test",
      type: ["VerifiableCredential", "KnownToAtumVerifiableCredential"],
      issuer: "did:web:atumlabs.xyz",
      issuanceDate: "2026-01-01T00:00:00Z",
      credentialSubject: {
        id: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        knownToAtum: true,
      },
    };
    const nquads = await canonicalize(doc);
    // eslint-disable-next-line no-console
    console.log(`synthetic knownToAtum VC canonical n-quads:\n${nquads}`);
    expect(
      nquads,
      `canonical n-quads missing kta:knownToAtum predicate — the defensive binding isn't taking effect, future producers that emit this field would have it silently dropped:\n${nquads}`
    ).toContain(
      "<https://schemas.atum.xyz/credentials/known-to-atum/v1#knownToAtum>"
    );
    // Boolean object — confirms @type: xsd:boolean in the binding
    // actually types the value. Without this, the field could bind but
    // with the wrong type, which would still drop or mis-canonicalize.
    expect(
      nquads,
      `canonical n-quads missing the xsd:boolean object for knownToAtum — the binding's @type isn't taking effect:\n${nquads}`
    ).toContain(`"true"^^<http://www.w3.org/2001/XMLSchema#boolean>`);
  });
});

// Byte-identity pin for the ed25519 VC-proof fixture. Same RFC 8032
// determinism contract as the FQ + VP halves above.
describe("conformance: ed25519 VC-proof fixtures are byte-identical across languages", () => {
  it("ed25519-go-vc-proof.json === ed25519-ts-vc-proof.json", () => {
    const goSigned = readFixture("ed25519-go-vc-proof.json");
    const tsSigned = readFixture("ed25519-ts-vc-proof.json");
    expect(goSigned.equals(tsSigned)).toBe(true);
  });
});

// Known-to-atum v2 credentials. Mirror of conformance_test.go's
// TestConformance_VerifyTSSignedKnownToAtumV2VCProofs. v2 adds the
// quoteAwarder and merchant roles, which v1 does not define; under v1 a
// credential's signature does not cover either role. Each fixture is a
// credential the issuer would emit under v2, signed in Go and verified here.
// Beyond verifying, each case checks that the role is in the signed bytes:
// changing the role, or naming the v1 context instead, must break the
// signature.
const KNOWN_TO_ATUM_V2_CONFORMANCE = [
  { name: "kta-v2-quote-awarder", role: "quoteAwarder", relabel: "merchant" },
  { name: "kta-v2-merchant", role: "merchant", relabel: "quoteAwarder" },
];
const KNOWN_TO_ATUM_V2_SUITES = [
  { suite: "secp256k1", sidecar: "vc-issuer-secp256k1.jwk.json" },
  { suite: "ed25519", sidecar: "vc-issuer-ed25519.jwk.json" },
];
const KTA_VOCABULARY = "https://schemas.atum.xyz/credentials/known-to-atum/v1#";

async function expectSignatureInvalid(
  change: string,
  vc: Record<string, unknown>,
  resolver: IssuerKeyResolver,
): Promise<void> {
  let caught: unknown;
  try {
    await verifyVCProof(vc, resolver);
  } catch (err) {
    caught = err;
  }
  expect(caught, `verifyVCProof accepted the credential with ${change}`).toBeInstanceOf(
    VPVCProofError,
  );
  expect((caught as VPVCProofError).reason, `with ${change}`).toBe("signatureInvalid");
}

describe("conformance: TS verifies Go-signed known-to-atum v2 credentials", () => {
  for (const c of KNOWN_TO_ATUM_V2_CONFORMANCE) {
    for (const s of KNOWN_TO_ATUM_V2_SUITES) {
      const fixture = `${s.suite}-go-vc-proof-${c.name}.json`;
      it(`${fixture}: verifies, and its signature covers the ${c.role} role`, async () => {
        const vc = JSON.parse(readFixture(fixture).toString("utf-8")) as Record<string, unknown>;
        const resolver = jwkSidecarResolver(s.sidecar);
        await expect(verifyVCProof(vc, resolver)).resolves.toBeUndefined();
        expect((vc.credentialSubject as Record<string, unknown>).role).toBe(c.role);
        await assertVCNquadsBindLoadBearingTerms(vc, fixture);

        const body = structuredClone(vc);
        delete body.proof;
        expect(await canonicalize(body)).toContain(
          `<${KTA_VOCABULARY}role> <${KTA_VOCABULARY}${c.role}> `,
        );

        const relabeled = structuredClone(vc);
        (relabeled.credentialSubject as Record<string, unknown>).role = c.relabel;
        await expectSignatureInvalid(`role ${c.relabel}`, relabeled, resolver);

        const underV1 = structuredClone(vc);
        underV1["@context"] = [W3C_VC_V1_CONTEXT_URL, KNOWN_TO_ATUM_V1_CONTEXT_URL];
        await expectSignatureInvalid("the v1 context", underV1, resolver);
      });
    }
  }

  it("ed25519 v2 fixtures are byte-identical across languages", () => {
    for (const c of KNOWN_TO_ATUM_V2_CONFORMANCE) {
      const goSigned = readFixture(`ed25519-go-vc-proof-${c.name}.json`);
      const tsSigned = readFixture(`ed25519-ts-vc-proof-${c.name}.json`);
      expect(goSigned.equals(tsSigned), `${c.name} ed25519 fixtures byte-diverged`).toBe(true);
    }
  });
});

// TS leg of the content-addressed quote_hash parity contract. Asserts
// computeQuoteHash reproduces the committed golden for every signed fixture;
// the Go conformance_test.go (TestConformance_QuoteHashMatchesGolden) asserts
// the same golden from ComputeQuoteHash. Both matching this one committed
// file is what pins Go↔TS quote_hash parity. Rebaseline: see conformance/README.md.
describe("conformance: content-addressed quote_hash parity (Go↔TS golden)", () => {
  const golden = JSON.parse(
    readFileSync(resolve(fixturesDir, "..", "quote-hash-golden.json"), "utf-8")
  ) as Record<string, string>;

  for (const name of [
    "secp256k1-go-signed.json",
    "secp256k1-ts-signed.json",
    "ed25519-go-signed.json",
    "ed25519-ts-signed.json",
  ]) {
    it(`${name}: computeQuoteHash matches the committed golden`, async () => {
      const got = await computeQuoteHash(readFixture(name).toString("utf-8"));
      expect(got).toBe(golden[name]);
    });
  }
});
