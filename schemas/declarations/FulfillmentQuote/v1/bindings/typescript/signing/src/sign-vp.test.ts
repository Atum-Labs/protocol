import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import nacl from "tweetnacl";

import { signVP } from "./sign-vp.js";
import { signVPEd25519 } from "./sign-vp-ed25519.js";
import { hashQuote, type HashableProofOptions } from "./hash.js";
import {
  assertDeclarationContextSupplied,
  W3C_VC_V1_CONTEXT_URL,
  FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
  SECP256K1_RECOVERY_CONTEXT_URL,
  ED25519_2020_CONTEXT_URL,
} from "./canonicalize.js";
import type { VerifiableCredential } from "@atum-labs/schema-declarations/FulfillmentQuoteEnvelope/v1/bindings/typescript";

// Pinned EVM key — same fixture pattern as the existing roundtrip suite.
// Tests are pure unit-level: no chain, no remote, no random key.
const FIXTURE_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function fixtureVC(id = "urn:uuid:vc-1"): VerifiableCredential {
  return {
    "@context": [W3C_VC_V1_CONTEXT_URL],
    id,
    type: ["VerifiableCredential", "KnownToAtumVerifiableCredential"],
    issuer: "did:web:issuer.atum.network",
    issuanceDate: "2026-01-01T00:00:00Z",
    credentialSubject: {
      id: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      knownToAtum: true,
    },
    proof: {
      type: "EcdsaSecp256k1RecoverySignature2020",
      created: "2026-01-01T00:00:00Z",
      verificationMethod:
        "did:web:issuer.atum.network#key-1",
      proofPurpose: "assertionMethod",
      jws: "FIXTURE_VC_JWS_NOT_VALIDATED_BY_SIGNVP_TESTS",
    },
  };
}

function fixtureSecpOpts() {
  // f39fd...92266 is the canonical hardhat #0 address for FIXTURE_PRIVATE_KEY.
  return {
    holder: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    verificationMethod:
      "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266#blockchainAccountId",
    challenge: "req-fixture-1",
    domain: "did:web:settler.atum.network",
    created: "2026-04-01T00:00:00.000Z",
  };
}

describe("signVP: secp256k1 envelope shape", () => {
  it("emits a wire-shape VP with VC v1 + envelope + cryptosuite contexts", async () => {
    const signed = await signVP([fixtureVC()], FIXTURE_PRIVATE_KEY, fixtureSecpOpts());

    expect(signed["@context"]).toEqual([
      W3C_VC_V1_CONTEXT_URL,
      FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
      SECP256K1_RECOVERY_CONTEXT_URL,
    ]);
    expect(signed.type).toEqual(["VerifiablePresentation"]);
    expect(signed.holder).toBe(fixtureSecpOpts().holder);
    expect(signed.verifiableCredential).toHaveLength(1);
    expect(signed.proof.type).toBe("EcdsaSecp256k1RecoverySignature2020");
    expect(signed.proof.proofPurpose).toBe("authentication");
    expect(signed.proof.challenge).toBe(fixtureSecpOpts().challenge);
    expect(signed.proof.domain).toBe(fixtureSecpOpts().domain);
    expect(signed.proof.jws).toMatch(/^[^.]+\.\.[^.]+$/); // detached JWS
  });

  it("produces a deterministic JWS given pinned inputs (incl. created)", async () => {
    const a = await signVP([fixtureVC()], FIXTURE_PRIVATE_KEY, fixtureSecpOpts());
    const b = await signVP([fixtureVC()], FIXTURE_PRIVATE_KEY, fixtureSecpOpts());
    expect(a.proof.jws).toBe(b.proof.jws);
  });

  it("recovers the holder address from the JWS (proves the VP body is what was signed)", async () => {
    const signed = await signVP([fixtureVC()], FIXTURE_PRIVATE_KEY, fixtureSecpOpts());
    // Reconstruct the signing input and recover; if the JWS was over
    // anything other than the VP body, recovery returns a different
    // address.
    const { signingInput } = await hashQuote(
      {
        "@context": signed["@context"],
        type: signed.type,
        holder: signed.holder,
        verifiableCredential: signed.verifiableCredential,
      } as Record<string, unknown>,
      {
        cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
        proofOptions: {
          type: "EcdsaSecp256k1RecoverySignature2020",
          created: signed.proof.created,
          verificationMethod: signed.proof.verificationMethod,
          proofPurpose: signed.proof.proofPurpose,
          challenge: signed.proof.challenge,
          domain: signed.proof.domain,
        },
        keepVerifiableCredential: true,
        // VerifyVP must use the same multi-context as signVP — without
        // it, challenge / domain wouldn't be in the canonical proof
        // bytes and recovery would yield a stranger address.
        proofContext: [
          FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
          SECP256K1_RECOVERY_CONTEXT_URL,
        ],
      }
    );
    const { recoverAddress } = await import("ethers");
    const parts = signed.proof.jws.split("..");
    const sigHex = "0x" + Buffer.from(parts[1], "base64url").toString("hex");
    const recovered = recoverAddress(signingInput, sigHex).toLowerCase();
    const expected = new Wallet(FIXTURE_PRIVATE_KEY).address.toLowerCase();
    expect(recovered).toBe(expected);
  });
});

describe("signVP: required option guards", () => {
  it("rejects empty verifiableCredentials array", async () => {
    await expect(
      signVP([], FIXTURE_PRIVATE_KEY, fixtureSecpOpts())
    ).rejects.toThrow(/at least one credential/i);
  });
  it.each(["holder", "verificationMethod", "challenge", "domain"] as const)(
    "rejects missing %s",
    async (field) => {
      const opts = { ...fixtureSecpOpts(), [field]: "" };
      await expect(
        signVP([fixtureVC()], FIXTURE_PRIVATE_KEY, opts)
      ).rejects.toThrow(new RegExp(field, "i"));
    }
  );
});

describe("signVP: VC array participates in the hash", () => {
  it("different VCs produce different signatures", async () => {
    const a = await signVP([fixtureVC("urn:uuid:vc-A")], FIXTURE_PRIVATE_KEY, fixtureSecpOpts());
    const b = await signVP([fixtureVC("urn:uuid:vc-B")], FIXTURE_PRIVATE_KEY, fixtureSecpOpts());
    expect(a.proof.jws).not.toBe(b.proof.jws);
  });

  // Layered-threat-model pin: the VP holder's signature binds
  // VC IDENTITY (id / issuer / issuanceDate / type:VerifiableCredential
  // + the VC's proof block) but NOT claim VALUES (credentialSubject.*
  // beyond `id`, custom VC types, or any term not in the active JSON-LD
  // context). With `safe: false` in canonicalize.ts, jsonld silently
  // drops unmapped terms; claim-integrity verification is the VC
  // issuer's signature (re-verified at the verifier layer), not the VP holder's.
  //
  // This test pins the intentional behavior so a future refactor that
  // "fixes" this surfaces as a test failure rather than a silent change.
  // Vendoring the known-to-atum context will INVERT this test —
  // once claim terms resolve through the strict loader, the VP signature
  // WILL cover them and this assertion flips. The flip is the operational
  // signal that the context vendoring landed correctly.
  it("mutating VC claim values does NOT change the VP signature", async () => {
    const baseline = fixtureVC();
    const a = await signVP([baseline], FIXTURE_PRIVATE_KEY, fixtureSecpOpts());

    // Mutate a non-identity claim field that's not in the active context.
    const mutatedExistingClaim = {
      ...baseline,
      credentialSubject: { ...baseline.credentialSubject, knownToAtum: false },
    };
    const b = await signVP([mutatedExistingClaim], FIXTURE_PRIVATE_KEY, fixtureSecpOpts());
    expect(b.proof.jws).toBe(a.proof.jws);

    // Add a new claim field — also not in the active context.
    const newClaim = {
      ...baseline,
      credentialSubject: { ...baseline.credentialSubject, settlerName: "rogue-settler" },
    };
    const c = await signVP([newClaim], FIXTURE_PRIVATE_KEY, fixtureSecpOpts());
    expect(c.proof.jws).toBe(a.proof.jws);

    // Change a custom VC type — also not in the active context.
    const customType = {
      ...baseline,
      type: ["VerifiableCredential", "KnownToAtumVerifiableCredential"],
    };
    const d = await signVP([customType], FIXTURE_PRIVATE_KEY, fixtureSecpOpts());
    expect(d.proof.jws).toBe(a.proof.jws);

    // Identity fields (issuer, issuanceDate, id) DO change the signature
    // since they're bound by the W3C VC v1 context. Sanity-check one of
    // them to keep the "this isn't trivially broken" guarantee.
    const mutatedIssuer = { ...baseline, issuer: "did:web:rogue.example" };
    const e = await signVP([mutatedIssuer], FIXTURE_PRIVATE_KEY, fixtureSecpOpts());
    expect(e.proof.jws).not.toBe(a.proof.jws);
  });
});

describe("signVP: replay-binding inputs participate in the hash", () => {
  it("different challenge produces a different signature", async () => {
    const a = await signVP([fixtureVC()], FIXTURE_PRIVATE_KEY, fixtureSecpOpts());
    const b = await signVP([fixtureVC()], FIXTURE_PRIVATE_KEY, {
      ...fixtureSecpOpts(),
      challenge: "req-other",
    });
    expect(a.proof.jws).not.toBe(b.proof.jws);
  });
  it("different domain produces a different signature", async () => {
    const a = await signVP([fixtureVC()], FIXTURE_PRIVATE_KEY, fixtureSecpOpts());
    const b = await signVP([fixtureVC()], FIXTURE_PRIVATE_KEY, {
      ...fixtureSecpOpts(),
      domain: "did:web:mismatched-verifier.example",
    });
    expect(a.proof.jws).not.toBe(b.proof.jws);
  });
});

// Lock the keepVerifiableCredential flag end-to-end: with it set, the VC
// array is part of the canonical input; without it (FQ default), the VC
// array is stripped, so the same body produces different SigningInputs.
describe("hashQuote: keepVerifiableCredential flag is load-bearing", () => {
  it("with VC present, keepVerifiableCredential changes the SigningInput", async () => {
    const body: Record<string, unknown> = {
      "@context": [
        W3C_VC_V1_CONTEXT_URL,
        FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
        SECP256K1_RECOVERY_CONTEXT_URL,
      ],
      type: ["VerifiablePresentation"],
      holder: fixtureSecpOpts().holder,
      verifiableCredential: [fixtureVC()],
    };
    const proofOptions: HashableProofOptions = {
      type: "EcdsaSecp256k1RecoverySignature2020",
      created: fixtureSecpOpts().created,
      verificationMethod: fixtureSecpOpts().verificationMethod,
      proofPurpose: "authentication",
      challenge: fixtureSecpOpts().challenge,
      domain: fixtureSecpOpts().domain,
    };
    const kept = await hashQuote(body, {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions,
      keepVerifiableCredential: true,
    });
    const stripped = await hashQuote(body, {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions,
    });
    expect(Buffer.from(kept.signingInput).equals(Buffer.from(stripped.signingInput))).toBe(false);
  });
});

// Ed25519 envelope: same property pin as secp256k1, plus a multibase
// proofValue check.
describe("signVPEd25519: envelope shape and determinism", () => {
  function ed25519Fixture() {
    // Pinned 64-byte secret key derived from a fixed seed so signatures
    // are reproducible. nacl.sign.keyPair.fromSeed yields { secretKey }
    // where secretKey is the 64-byte form.
    const seed = new Uint8Array(32).fill(7);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const pubBase58 = require("bs58").default.encode(Buffer.from(kp.publicKey));
    return {
      secretKey: kp.secretKey,
      opts: {
        holder: `did:pkh:solana:devnet:${pubBase58}`,
        verificationMethod: `did:pkh:solana:devnet:${pubBase58}#blockchainAccountId`,
        challenge: "req-fixture-1",
        domain: "did:web:settler.atum.network",
        created: "2026-04-01T00:00:00.000Z",
      },
    };
  }

  it("emits a wire-shape VP with ed25519 context and z-base58btc proofValue", async () => {
    const { secretKey, opts } = ed25519Fixture();
    const signed = await signVPEd25519([fixtureVC()], secretKey, opts);
    expect(signed["@context"]).toEqual([
      W3C_VC_V1_CONTEXT_URL,
      FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
      ED25519_2020_CONTEXT_URL,
    ]);
    expect(signed.type).toEqual(["VerifiablePresentation"]);
    expect(signed.proof.type).toBe("Ed25519Signature2020");
    expect(signed.proof.proofPurpose).toBe("authentication");
    expect(signed.proof.challenge).toBe(opts.challenge);
    expect(signed.proof.domain).toBe(opts.domain);
    expect(signed.proof.proofValue.startsWith("z")).toBe(true);
  });

  it("produces a deterministic proofValue given pinned inputs", async () => {
    const { secretKey, opts } = ed25519Fixture();
    const a = await signVPEd25519([fixtureVC()], secretKey, opts);
    const b = await signVPEd25519([fixtureVC()], secretKey, opts);
    expect(a.proof.proofValue).toBe(b.proof.proofValue);
  });

  it("rejects a 32-byte seed", async () => {
    const seed = new Uint8Array(32).fill(7);
    const { opts } = ed25519Fixture();
    await expect(signVPEd25519([fixtureVC()], seed, opts)).rejects.toThrow(/64 bytes/);
  });
});

// Declaration-context guard: a non-FQE declarationType only binds
// (emits its rdf:type n-quad) when its declaration context is overlaid on the
// strict loader. Without it, safe:false canonicalization silently drops the
// term — so the signer must throw rather than mint an unbound VP. The guard
// itself is the pure helper assertDeclarationContextSupplied; tested directly
// here (no canonicalization) plus one integration assertion that signVP wires it.
describe("assertDeclarationContextSupplied (declaration-context guard)", () => {
  const PRE_URL =
    "https://schemas.atum.network/declarations/PaymentRequestEnvelope/v1/context.jsonld";

  it("no-ops for an undefined declaration type", () => {
    expect(() =>
      assertDeclarationContextSupplied(undefined, FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL, undefined),
    ).not.toThrow();
  });

  it("no-ops for the FQE declaration type under the default context", () => {
    expect(() =>
      assertDeclarationContextSupplied(
        "FulfillmentQuoteEnvelope",
        FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
        undefined,
      ),
    ).not.toThrow();
  });

  it("throws for a non-FQE type with no envelope context override", () => {
    expect(() =>
      assertDeclarationContextSupplied(
        "PaymentRequestEnvelope",
        FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
        undefined,
      ),
    ).toThrow(/requires its declaration context/);
  });

  it("throws for a non-FQE type whose URL is set but not supplied via extraEnvelopeContexts", () => {
    expect(() =>
      assertDeclarationContextSupplied("PaymentRequestEnvelope", PRE_URL, {}),
    ).toThrow(/requires its declaration context/);
  });

  it("allows a non-FQE type when its context URL is supplied", () => {
    expect(() =>
      assertDeclarationContextSupplied("PaymentRequestEnvelope", PRE_URL, {
        [PRE_URL]: { "@context": {} },
      }),
    ).not.toThrow();
  });

  it("signVP wires the guard (throws before canonicalization)", async () => {
    await expect(
      signVP([fixtureVC()], FIXTURE_PRIVATE_KEY, {
        ...fixtureSecpOpts(),
        declarationType: "PaymentRequestEnvelope",
      }),
    ).rejects.toThrow(/requires its declaration context/);
  });
});
