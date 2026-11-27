import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { type BaseWallet, Wallet } from "ethers";
import nacl from "tweetnacl";
import bs58 from "bs58";

import {
  KNOWN_TO_ATUM_V1_CONTEXT_URL,
  W3C_VC_V1_CONTEXT_URL,
  settlerProofTypedDigest,
} from "@atum-labs/ld-data-integrity";

import {
  FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
  SECP256K1_RECOVERY_CONTEXT_URL,
} from "./canonicalize.js";
import { hashQuote } from "./hash.js";
import { createDetachedJws } from "./jws.js";
import { signVP } from "./sign-vp.js";
import { signVPEd25519 } from "./sign-vp-ed25519.js";
import { encodeStellarAccount } from "./strkey.js";
import { verifyVP, recoverHolder, type VerifyVPOptions } from "./verify-vp.js";
import type { VerifiableCredential } from "@atum-labs/schema-declarations/FulfillmentQuoteEnvelope/v1/bindings/typescript";

// Fixture clock pinned to the same instant signVPSecp uses by default.
const FIXTURE_NOW = new Date("2026-05-20T00:00:30.000Z");
const FIXTURE_CREATED = "2026-05-20T00:00:00.000Z";
const FIXTURE_CHALLENGE = "req-fixture-1";
const FIXTURE_DOMAIN = "did:web:settler.atum.network";

// fixtureVC builds a stub VC bound to `holder` as its credentialSubject.id.
// The subject-holder binding enforces credentialSubject.id == VP.holder; passing the holder
// here keeps the rejection-path tests focused on the gate they intend to
// exercise (date window, issuer trust, missing type) rather than tripping
// the subject-holder gate first. Subject-holder rejection tests pass a
// *different* DID via overrides.
function fixtureVC(holder: string, overrides: Partial<VerifiableCredential> = {}): VerifiableCredential {
  const id = overrides.id ?? fixtureVCID("EcdsaSecp256k1RecoverySignature2020", holder, overrides);
  return {
    // Fixture VCs MUST carry the
    // known-to-atum context so the `role` claim and the
    // KnownToAtumVerifiableCredential @type alias bind to stable
    // IRIs. Without this, both are silently dropped during URDNA2015
    // expansion — the unsigned-claim anti-pattern the binding
    // set out to eliminate.
    "@context": [
      W3C_VC_V1_CONTEXT_URL,
      KNOWN_TO_ATUM_V1_CONTEXT_URL,
    ],
    id,
    type: ["VerifiableCredential", "KnownToAtumVerifiableCredential"],
    issuer: "did:web:atumlabs.xyz",
    issuanceDate: "2026-01-01T00:00:00Z",
    credentialSubject: { id: stripDIDFragment(holder), role: "settler" },
    proof: {
      // VC stub proof — this path doesn't verify VC sigs (deferred to
      // the issuer-proof verification gate). type matches the outer VP cryptosuite so the VP's
      // @context covers canonicalization.
      type: "EcdsaSecp256k1RecoverySignature2020",
      created: "2026-01-01T00:00:00Z",
      verificationMethod: "did:web:atumlabs.xyz#key-1",
      proofPurpose: "assertionMethod",
      jws: stubSignature(id),
    },
    ...overrides,
  };
}

// fixtureVCID derives a credential id from every argument that shapes the
// credential. Real issuers mint a fresh id per credential; a shared id
// would make two credentials in one presentation the same RDF subject, and
// the stub signature is keyed on this id. Hashing the arguments keeps
// fixtures reproducible while giving distinct credentials distinct ids.
function fixtureVCID(suite: string, holder: string, overrides: Partial<VerifiableCredential> = {}): string {
  const b = createHash("sha256")
    .update(JSON.stringify([suite, holder, overrides]))
    .digest()
    .subarray(0, 16);
  // Stamp the RFC 9562 version-8 (custom) and variant bits so the value is
  // a well-formed UUID rather than arbitrary hex in uuid clothing.
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A real proof carries a signature unique to its credential. Without one,
// two stub proofs with equal type/created/method/purpose have identical
// first-degree RDF quads regardless of the credential id (a proof is a
// blank node in its own graph, so the owning credential never appears in
// those quads), and canonicalization refuses them as indistinguishable.
// The placeholder is keyed on the id and is never verified on this path.
function stubSignature(id: string): string {
  return `stub-signature-of:${id}`;
}

// Defensive helper for fixtureVC: every current caller passes a bare
// did:pkh holder, but the helper keeps `credentialSubject.id` bare even
// if a future test passes `did:pkh:...#blockchainAccountId`. The
// production verifier's holderEquals strips fragments on both sides too,
// so this stays symmetric with the wire contract.
function stripDIDFragment(did: string): string {
  const i = did.indexOf("#");
  return i >= 0 ? did.slice(0, i) : did;
}

function happyOpts(holder: string): VerifyVPOptions {
  return {
    expectedChallenge: FIXTURE_CHALLENGE,
    expectedDomain: FIXTURE_DOMAIN,
    expectedHolder: holder,
    now: FIXTURE_NOW,
    maxProofAgeMs: 5 * 60 * 1000,
    maxFutureSkewMs: 30 * 1000,
    requiredVCTypes: ["KnownToAtumVerifiableCredential"],
  };
}

describe("verifyVP: secp256k1 round-trip", () => {
  it("verifies a signVP-produced envelope and returns the recovered holder", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const signed = await signVP([fixtureVC(holder)], wallet.privateKey, {
      holder,
      verificationMethod: `${holder}#blockchainAccountId`,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    });

    const res = await verifyVP(signed as unknown as Record<string, unknown>, happyOpts(holder));
    expect(res.cryptosuite).toBe("EcdsaSecp256k1RecoverySignature2020");
    expect(res.holder).toBe(holder);
    expect(res.signerAddress).toBe(wallet.address.toLowerCase());
    expect(res.didNetwork).toBe("eip155:1");
    expect(res.attestedClaims).toHaveLength(1);
  });

  it("recoverHolder returns just the holder DID", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const signed = await signVP([fixtureVC(holder)], wallet.privateKey, {
      holder,
      verificationMethod: `${holder}#blockchainAccountId`,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    });

    const got = await recoverHolder(signed as unknown as Record<string, unknown>, happyOpts(holder));
    expect(got).toBe(holder);
  });
});

describe("verifyVP: SettlerProof typed signature", () => {
  // Re-signs a signVP envelope over the SettlerProof typed digest of the same proofHash and docHash.
  async function signTypedVP(signer: BaseWallet, holder: string): Promise<Record<string, unknown>> {
    const signed = (await signVP([fixtureVC(holder)], signer.privateKey, {
      holder,
      verificationMethod: `${holder}#blockchainAccountId`,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    })) as unknown as Record<string, unknown>;
    const { proof, ...doc } = signed as { proof: Record<string, unknown> };
    const { proofHash, docHash } = await hashQuote(doc, {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions: {
        type: "EcdsaSecp256k1RecoverySignature2020",
        created: proof.created as string,
        verificationMethod: proof.verificationMethod as string,
        proofPurpose: proof.proofPurpose as string,
        challenge: proof.challenge as string,
        domain: proof.domain as string,
      },
      keepVerifiableCredential: true,
      proofContext: proof["@context"] ?? [
        FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
        SECP256K1_RECOVERY_CONTEXT_URL,
      ],
    });
    const sig = signer.signingKey.sign(settlerProofTypedDigest(proofHash, docHash));
    const jws = createDetachedJws(Buffer.from(sig.serialized.slice(2), "hex"));
    return { ...doc, proof: { ...proof, jws } };
  }

  it("accepts a typed signature by the holder key", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const res = await verifyVP(await signTypedVP(wallet, holder), happyOpts(holder));
    expect(res.signerAddress).toBe(wallet.address.toLowerCase());
  });

  it("rejects a typed signature by another key", async () => {
    const victim = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${victim.address.toLowerCase()}`;
    const envelope = await signTypedVP(Wallet.createRandom(), holder);
    await expect(verifyVP(envelope, happyOpts(holder))).rejects.toThrow(/does not match/);
  });
});

describe("verifyVP: ed25519 round-trip", () => {
  it("verifies a signVPEd25519-produced envelope", async () => {
    const seed = new Uint8Array(32).fill(7);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const pubBase58 = bs58.encode(Buffer.from(kp.publicKey));
    const holder = `did:pkh:solana:devnet:${pubBase58}`;
    const signed = await signVPEd25519([fixtureEd25519VC(holder)], kp.secretKey, {
      holder,
      verificationMethod: `${holder}#blockchainAccountId`,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    });

    const res = await verifyVP(signed as unknown as Record<string, unknown>, happyOpts(holder));
    expect(res.cryptosuite).toBe("Ed25519Signature2020");
    expect(res.holder).toBe(holder);
    expect(res.didNetwork).toBe("solana:devnet");
    expect(res.signerAddress).toBe("");
    expect(res.ed25519PublicKey).not.toBeNull();
  });
});

describe("verifyVP: stellar ed25519 holder", () => {
  const stellarOptions = (secretKey: Uint8Array, holder: string, vm: string) => ({
    holder,
    verificationMethod: vm,
    challenge: FIXTURE_CHALLENGE,
    domain: FIXTURE_DOMAIN,
    created: FIXTURE_CREATED,
    secretKey,
  });

  it("verifies a VP whose holder is the signer's G account", async () => {
    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const holder = `did:pkh:stellar:pubnet:${encodeStellarAccount(kp.publicKey)}`;
    const o = stellarOptions(kp.secretKey, holder, `${holder}#blockchainAccountId`);
    const signed = await signVPEd25519([fixtureEd25519VC(holder)], o.secretKey, o);

    const res = await verifyVP(signed as unknown as Record<string, unknown>, happyOpts(holder));
    expect(res.cryptosuite).toBe("Ed25519Signature2020");
    expect(res.holder).toBe(holder);
    expect(res.didNetwork).toBe("stellar:pubnet");
  });

  it("rejects an attacker signing under their own G account while naming the victim as holder", async () => {
    const attacker = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    const victim = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
    const victimHolder = `did:pkh:stellar:pubnet:${encodeStellarAccount(victim.publicKey)}`;
    const attackerVM = `did:pkh:stellar:pubnet:${encodeStellarAccount(attacker.publicKey)}#blockchainAccountId`;
    const o = stellarOptions(attacker.secretKey, victimHolder, attackerVM);
    const signed = (await signVPEd25519([fixtureEd25519VC(victimHolder)], o.secretKey, o)) as unknown as Record<
      string,
      unknown
    >;

    await expect(verifyVP(signed, happyOpts(victimHolder))).rejects.toThrow(
      /recovered ed25519 pubkey .* does not match stellar holder address/,
    );
  });
});

function fixtureEd25519VC(holder: string): VerifiableCredential {
  // The ed25519 VP's @context includes the ed25519 cryptosuite context,
  // so the VC's stub proof.type can be Ed25519Signature2020 here.
  // credentialSubject.id MUST equal the VP holder — pass it
  // through so happy-path tests don't trip the subject-holder gate.
  const id = fixtureVCID("Ed25519Signature2020", holder);
  return {
    // See fixtureVC for the same kta-
    // context note. Ed25519 path needs the same binding so the
    // KnownToAtumVerifiableCredential @type + role claim are
    // signed-bytes-attested rather than silently dropped.
    "@context": [
      W3C_VC_V1_CONTEXT_URL,
      KNOWN_TO_ATUM_V1_CONTEXT_URL,
    ],
    id,
    type: ["VerifiableCredential", "KnownToAtumVerifiableCredential"],
    issuer: "did:web:atumlabs.xyz",
    issuanceDate: "2026-01-01T00:00:00Z",
    credentialSubject: { id: stripDIDFragment(holder), role: "settler" },
    proof: {
      type: "Ed25519Signature2020",
      created: "2026-01-01T00:00:00Z",
      verificationMethod: "did:web:atumlabs.xyz#key-1",
      proofPurpose: "assertionMethod",
      proofValue: stubSignature(id),
    },
  };
}

describe("verifyVP: rejection paths", () => {
  async function buildSignedSecp(over: { holder?: string; challenge?: string; domain?: string } = {}) {
    const wallet = Wallet.createRandom();
    const holder = over.holder ?? `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const signed = await signVP([fixtureVC(holder)], wallet.privateKey, {
      holder,
      verificationMethod: `${holder}#blockchainAccountId`,
      challenge: over.challenge ?? FIXTURE_CHALLENGE,
      domain: over.domain ?? FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    });
    return { signed: signed as unknown as Record<string, unknown>, holder, wallet };
  }

  it("rejects a mismatched holder (caller-side consistency check)", async () => {
    const { signed } = await buildSignedSecp();
    const opts = happyOpts("did:pkh:eip155:1:0xdeadbeef00000000000000000000000000000000");
    await expect(verifyVP(signed, opts)).rejects.toThrow(/does not match ExpectedHolder/);
  });

  it("rejects a mismatched challenge (cross-auction replay binding)", async () => {
    const { signed, holder } = await buildSignedSecp();
    const opts = { ...happyOpts(holder), expectedChallenge: "req-WRONG" };
    await expect(verifyVP(signed, opts)).rejects.toThrow(/challenge/);
  });

  it("rejects a mismatched domain (cross-environment replay binding)", async () => {
    const { signed, holder } = await buildSignedSecp();
    const opts = { ...happyOpts(holder), expectedDomain: "did:web:mismatched-verifier.example" };
    await expect(verifyVP(signed, opts)).rejects.toThrow(/domain/);
  });

  it("rejects a tampered ed25519 proofValue (sig verification)", async () => {
    const seed = new Uint8Array(32).fill(7);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const pubBase58 = bs58.encode(Buffer.from(kp.publicKey));
    const holder = `did:pkh:solana:devnet:${pubBase58}`;
    const signed = (await signVPEd25519([fixtureEd25519VC(holder)], kp.secretKey, {
      holder,
      verificationMethod: `${holder}#blockchainAccountId`,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    })) as unknown as Record<string, unknown> & { proof: { proofValue: string } };
    const pv = signed.proof.proofValue;
    signed.proof.proofValue = pv.slice(0, -5) + "AAAAA";
    await expect(verifyVP(signed, happyOpts(holder))).rejects.toThrow(/ed25519 signature/);
  });

  it("rejects an expired VC", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const signed = await signVP(
      [fixtureVC(holder, { expirationDate: "2026-05-19T00:00:00Z" } as Partial<VerifiableCredential>)],
      wallet.privateKey,
      {
        holder,
        verificationMethod: `${holder}#blockchainAccountId`,
        challenge: FIXTURE_CHALLENGE,
        domain: FIXTURE_DOMAIN,
        created: FIXTURE_CREATED,
      }
    );
    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, happyOpts(holder))
    ).rejects.toThrow(/expired/);
  });

  it("rejects a future-dated VC", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const signed = await signVP(
      [fixtureVC(holder, { issuanceDate: "2027-01-01T00:00:00Z" })],
      wallet.privateKey,
      {
        holder,
        verificationMethod: `${holder}#blockchainAccountId`,
        challenge: FIXTURE_CHALLENGE,
        domain: FIXTURE_DOMAIN,
        created: FIXTURE_CREATED,
      }
    );
    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, happyOpts(holder))
    ).rejects.toThrow(/future/);
  });

  // Mirror of Go's TestVerifyVP_RefusesVCWithoutIssuanceDate: a VC with no
  // issuance date is refused however the wire leaves it out. The holder signs
  // every case, so the refusal is the credential check, not the signature.
  describe("rejects a VC without an issuanceDate", () => {
    const cases: ReadonlyArray<readonly [string, (vc: Record<string, unknown>) => void]> = [
      ["null", (vc) => { vc.issuanceDate = null; }],
      ["absent", (vc) => { delete vc.issuanceDate; }],
      ["empty string", (vc) => { vc.issuanceDate = ""; }],
    ];
    for (const [name, mutate] of cases) {
      it(`${name} (secp256k1)`, async () => {
        const wallet = Wallet.createRandom();
        const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
        const vc = fixtureVC(holder) as unknown as Record<string, unknown>;
        mutate(vc);
        const signed = await signVP([vc as unknown as VerifiableCredential], wallet.privateKey, {
          holder,
          verificationMethod: `${holder}#blockchainAccountId`,
          challenge: FIXTURE_CHALLENGE,
          domain: FIXTURE_DOMAIN,
          created: FIXTURE_CREATED,
        });
        await expect(
          verifyVP(signed as unknown as Record<string, unknown>, happyOpts(holder))
        ).rejects.toThrow(/missing or non-string field "issuanceDate"/);
      });
      it(`${name} (ed25519)`, async () => {
        const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const holder = `did:pkh:solana:devnet:${bs58.encode(Buffer.from(kp.publicKey))}`;
        const vc = fixtureEd25519VC(holder) as unknown as Record<string, unknown>;
        mutate(vc);
        const signed = await signVPEd25519([vc as unknown as VerifiableCredential], kp.secretKey, {
          holder,
          verificationMethod: `${holder}#blockchainAccountId`,
          challenge: FIXTURE_CHALLENGE,
          domain: FIXTURE_DOMAIN,
          created: FIXTURE_CREATED,
        });
        await expect(
          verifyVP(signed as unknown as Record<string, unknown>, happyOpts(holder))
        ).rejects.toThrow(/missing or non-string field "issuanceDate"/);
      });
    }
  });

  // signers sign a one-credential envelope under each cryptosuite after
  // `mutate` edits the default VC, so the holder signature covers the edit.
  type MutateVC = (vc: Record<string, unknown>) => void;
  const signers: ReadonlyArray<
    readonly [string, (mutate: MutateVC) => Promise<{ signed: Record<string, unknown>; holder: string }>]
  > = [
    [
      "secp256k1",
      async (mutate) => {
        const wallet = Wallet.createRandom();
        const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
        const vc = fixtureVC(holder) as unknown as Record<string, unknown>;
        mutate(vc);
        const signed = await signVP([vc as unknown as VerifiableCredential], wallet.privateKey, {
          holder,
          verificationMethod: `${holder}#blockchainAccountId`,
          challenge: FIXTURE_CHALLENGE,
          domain: FIXTURE_DOMAIN,
          created: FIXTURE_CREATED,
        });
        return { signed: signed as unknown as Record<string, unknown>, holder };
      },
    ],
    [
      "ed25519",
      async (mutate) => {
        const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const holder = `did:pkh:solana:devnet:${bs58.encode(Buffer.from(kp.publicKey))}`;
        const vc = fixtureEd25519VC(holder) as unknown as Record<string, unknown>;
        mutate(vc);
        const signed = await signVPEd25519([vc as unknown as VerifiableCredential], kp.secretKey, {
          holder,
          verificationMethod: `${holder}#blockchainAccountId`,
          challenge: FIXTURE_CHALLENGE,
          domain: FIXTURE_DOMAIN,
          created: FIXTURE_CREATED,
        });
        return { signed: signed as unknown as Record<string, unknown>, holder };
      },
    ],
  ];

  // Mirror of the zero-instant cases in Go's
  // TestVerifyVP_RefusesVCWithoutIssuanceDate. Go decodes a null
  // issuanceDate to its zero time and refuses both, so this verifier refuses
  // the zero instant too, in any offset spelling.
  describe("rejects an issuanceDate at the zero instant", () => {
    for (const value of ["0001-01-01T00:00:00Z", "0001-01-01T01:00:00+01:00"]) {
      for (const [suite, sign] of signers) {
        it(`${value} (${suite})`, async () => {
          const { signed, holder } = await sign((vc) => {
            vc.issuanceDate = value;
          });
          await expect(verifyVP(signed, happyOpts(holder))).rejects.toThrow(/is the zero instant/);
        });
      }
    }
  });

  // An expirationDate that is present must be a date string, as Go's decoder
  // requires. Null still means no expiry, and the zero instant is a past
  // expiry, as in Go's TestVerifyVP_ZeroInstantExpirationDateIsExpired.
  describe("expirationDate", () => {
    for (const [suite, sign] of signers) {
      for (const value of ["", 5]) {
        it(`rejects an expirationDate that is not a date string: ${JSON.stringify(value)} (${suite})`, async () => {
          const { signed, holder } = await sign((vc) => {
            vc.expirationDate = value;
          });
          await expect(verifyVP(signed, happyOpts(holder))).rejects.toThrow(
            /verifiableCredential\[0\]\.expirationDate is not a date string/
          );
        });
      }
      for (const value of ["0001-01-01T00:00:00Z", "0001-01-01T01:00:00+01:00"]) {
        it(`treats an expirationDate at the zero instant as expired: ${value} (${suite})`, async () => {
          const { signed, holder } = await sign((vc) => {
            vc.expirationDate = value;
          });
          await expect(verifyVP(signed, happyOpts(holder))).rejects.toThrow(/expired/);
        });
      }
      it(`verifies a null expirationDate as no expiry (${suite})`, async () => {
        const { signed, holder } = await sign((vc) => {
          vc.expirationDate = null;
        });
        await expect(verifyVP(signed, happyOpts(holder))).resolves.toBeDefined();
      });
    }
  });

  // Mirror of Go's TestVerifyVP_NullIssuanceDateOnSecondVC_Refused: the
  // issuanceDate check runs on every credential, not only the first. The
  // control signs the same two credentials with a valid date on the second,
  // so the refusal is the second credential's null.
  describe("checks the issuanceDate of every credential", () => {
    async function signWithSecond(issuanceDate: string | null) {
      const wallet = Wallet.createRandom();
      const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
      const second = fixtureVC(holder, {
        id: "urn:uuid:vc-second",
        type: ["VerifiableCredential", "Unrelated"],
      }) as unknown as Record<string, unknown>;
      second.issuanceDate = issuanceDate;
      const signed = await signVP(
        [fixtureVC(holder), second as unknown as VerifiableCredential],
        wallet.privateKey,
        {
          holder,
          verificationMethod: `${holder}#blockchainAccountId`,
          challenge: FIXTURE_CHALLENGE,
          domain: FIXTURE_DOMAIN,
          created: FIXTURE_CREATED,
        }
      );
      return { signed: signed as unknown as Record<string, unknown>, holder };
    }

    // The second credential's type is reserved, so it walks every check;
    // an unreserved one is passed through unchecked instead.
    const reservedSecond = (holder: string) => ({ ...happyOpts(holder), reservedVCTypes: ["Unrelated"] });

    it("rejects a null issuanceDate on the second credential", async () => {
      const { signed, holder } = await signWithSecond(null);
      await expect(verifyVP(signed, reservedSecond(holder))).rejects.toThrow(
        /missing or non-string field "issuanceDate"/
      );
    });

    it("verifies the same envelope with a valid issuanceDate on the second credential (control)", async () => {
      const { signed, holder } = await signWithSecond("2026-01-01T00:00:00Z");
      const result = await verifyVP(signed, reservedSecond(holder));
      expect(result.attestedClaims).toHaveLength(2);
    });
  });

  it("rejects an untrusted issuer in strict mode", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const signed = await signVP(
      [fixtureVC(holder, { issuer: "did:web:rogue.example" })],
      wallet.privateKey,
      {
        holder,
        verificationMethod: `${holder}#blockchainAccountId`,
        challenge: FIXTURE_CHALLENGE,
        domain: FIXTURE_DOMAIN,
        created: FIXTURE_CREATED,
      }
    );

    const opts: VerifyVPOptions = {
      ...happyOpts(holder),
      isIssuerTrusted: (did) => ({ allowed: did === "did:web:atumlabs.xyz", enforced: true }),
    };
    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, opts)
    ).rejects.toThrow(/trust anchors/);
  });

  it("permissive mode passes a non-trusted issuer through", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const signed = await signVP(
      [fixtureVC(holder, { issuer: "did:web:not-in-list.example" })],
      wallet.privateKey,
      {
        holder,
        verificationMethod: `${holder}#blockchainAccountId`,
        challenge: FIXTURE_CHALLENGE,
        domain: FIXTURE_DOMAIN,
        created: FIXTURE_CREATED,
      }
    );
    const opts: VerifyVPOptions = {
      ...happyOpts(holder),
      isIssuerTrusted: () => ({ allowed: false, enforced: false }),
    };
    const res = await verifyVP(signed as unknown as Record<string, unknown>, opts);
    expect(res.holder).toBe(holder);
  });

  it("rejects missing required VC type", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const signed = await signVP(
      [fixtureVC(holder, { type: ["VerifiableCredential"] })],
      wallet.privateKey,
      {
        holder,
        verificationMethod: `${holder}#blockchainAccountId`,
        challenge: FIXTURE_CHALLENGE,
        domain: FIXTURE_DOMAIN,
        created: FIXTURE_CREATED,
      }
    );
    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, happyOpts(holder))
    ).rejects.toThrow(/requiredVCTypes/);
  });

  // credentialSubject.id MUST equal the VP holder. Closes the
  // "presenter swaps in someone else's valid VC" path on the cheap path
  // (string compare) ahead of full VC-signature verification.
  it("rejects a VC whose credentialSubject.id is a different chain account", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const otherWallet = Wallet.createRandom();
    const otherSubject = `did:pkh:eip155:1:${otherWallet.address.toLowerCase()}`;
    const signed = await signVP(
      [fixtureVC(holder, { credentialSubject: { id: otherSubject, role: "settler" } as VerifiableCredential["credentialSubject"] })],
      wallet.privateKey,
      {
        holder,
        verificationMethod: `${holder}#blockchainAccountId`,
        challenge: FIXTURE_CHALLENGE,
        domain: FIXTURE_DOMAIN,
        created: FIXTURE_CREATED,
      }
    );
    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, happyOpts(holder))
    ).rejects.toThrow(/credentialSubject\.id .* does not equal VP holder/);
  });

  it("rejects a VC whose credentialSubject.id is on a different chain namespace", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const wrongChainSubject = `did:pkh:solana:devnet:${wallet.address.toLowerCase()}`;
    const signed = await signVP(
      [fixtureVC(holder, { credentialSubject: { id: wrongChainSubject, role: "settler" } as VerifiableCredential["credentialSubject"] })],
      wallet.privateKey,
      {
        holder,
        verificationMethod: `${holder}#blockchainAccountId`,
        challenge: FIXTURE_CHALLENGE,
        domain: FIXTURE_DOMAIN,
        created: FIXTURE_CREATED,
      }
    );
    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, happyOpts(holder))
    ).rejects.toThrow(/credentialSubject\.id .* does not equal VP holder/);
  });

  // A structurally malformed VC (credentialSubject missing
  // the `id` key) routes to the malformed-input error path, NOT the
  // subject-holder-mismatch sentinel. Dashboards split malformed-vs-
  // adversarial so the rejection reason stays informative; a regression
  // that conflated them would silently lose that signal.
  //
  // Broader malformed-subject coverage (non-string id, array, object,
  // null, etc.) is unit-tested on the Go side
  // (TestCheckVCSubjectMatchesHolder_MalformedSubject) because the
  // canonicalizer rejects non-string @id values upstream of verifyVP,
  // making those shapes unreachable via a properly-signed VP. The
  // missing-id case below IS reachable because URDNA2015 treats a VC
  // without @id as a blank node.
  it("rejects a VC with credentialSubject missing the id key", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const signed = await signVP(
      [fixtureVC(holder, { credentialSubject: { role: "settler" } as VerifiableCredential["credentialSubject"] })],
      wallet.privateKey,
      {
        holder,
        verificationMethod: `${holder}#blockchainAccountId`,
        challenge: FIXTURE_CHALLENGE,
        domain: FIXTURE_DOMAIN,
        created: FIXTURE_CREATED,
      }
    );
    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, happyOpts(holder))
    ).rejects.toThrow(/credentialSubject\.id missing or not a string/);
  });

  it("accepts a VC whose credentialSubject.id matches a holder DID with #fragment suffix", async () => {
    // ExpectedHolder carries the bare DID at the verifier, but the
    // VP holder field may carry a #blockchainAccountId fragment. The
    // subject-holder check uses holderEquals (which strips fragments),
    // so a bare credentialSubject.id MUST still match a holder DID with
    // a fragment.
    const wallet = Wallet.createRandom();
    const bareHolder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const signed = await signVP(
      [fixtureVC(bareHolder)],
      wallet.privateKey,
      {
        holder: bareHolder,
        verificationMethod: `${bareHolder}#blockchainAccountId`,
        challenge: FIXTURE_CHALLENGE,
        domain: FIXTURE_DOMAIN,
        created: FIXTURE_CREATED,
      }
    );
    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, happyOpts(bareHolder))
    ).resolves.toMatchObject({ holder: bareHolder });
  });

  // An issuer minting did:pkh / CAIP-10 subjects in
  // the EIP-55 checksummed form (the canonical recommendation) MUST
  // still match a lowercase holder DID. EIP-55 mixed-case is a
  // checksum over the SAME account; an exact byte compare would lock
  // out every legitimate settler whose issuer emits checksummed
  // subjects. holderEquals already case-folds eip155 addresses; this test
  // pins that contract specifically on the subject-holder gate so a
  // future refactor that flattens the chain-aware switch back to
  // exact-compare fails here rather than at a settler in production.
  //
  // Solana/Tron exact-compare contract is covered by the
  // "rejects a case-flipped Solana address segment" test in the
  // holderEquals semantics describe block; this is the eip155 half.
  it("accepts a checksummed (EIP-55) credentialSubject.id against a lowercase holder", async () => {
    const wallet = Wallet.createRandom();
    // ethers' Wallet.address is EIP-55 checksummed by default — that's
    // the canonical issuer-side casing. Use it verbatim for the
    // subject and lowercase for the holder so the gate exercises the
    // case-fold path on the address segment.
    const checksummedAddr = wallet.address;
    const lowercaseAddr = wallet.address.toLowerCase();
    if (checksummedAddr === lowercaseAddr) {
      // Defensive: if EIP-55 for this random key happens to produce
      // an all-lowercase result, the test exercises nothing. Force
      // a casing perturbation so the bytes definitely differ.
      throw new Error("expected EIP-55 to produce mixed-case for this key");
    }
    const lowercaseHolder = `did:pkh:eip155:1:${lowercaseAddr}`;
    const subjectDID = `did:pkh:eip155:1:${checksummedAddr}`;
    const signed = await signVP(
      [fixtureVC(lowercaseHolder, { credentialSubject: { id: subjectDID, role: "settler" } as VerifiableCredential["credentialSubject"] })],
      wallet.privateKey,
      {
        holder: lowercaseHolder,
        verificationMethod: `${lowercaseHolder}#blockchainAccountId`,
        challenge: FIXTURE_CHALLENGE,
        domain: FIXTURE_DOMAIN,
        created: FIXTURE_CREATED,
      }
    );
    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, happyOpts(lowercaseHolder))
    ).resolves.toMatchObject({ holder: lowercaseHolder });
  });

  it("rejects proof.proofPurpose = assertionMethod (FQ-style; VP must be authentication)", async () => {
    const { signed, holder } = await buildSignedSecp();
    (signed.proof as Record<string, unknown>).proofPurpose = "assertionMethod";
    await expect(verifyVP(signed, happyOpts(holder))).rejects.toThrow(/proofPurpose/);
  });

  it("rejects stale freshness (proof older than maxProofAgeMs)", async () => {
    const { signed, holder } = await buildSignedSecp();
    const opts = { ...happyOpts(holder), now: new Date("2026-05-20T01:00:00Z") };
    await expect(verifyVP(signed, opts)).rejects.toThrow(/older than maxProofAgeMs/);
  });

  it("rejects future-skewed proof.created", async () => {
    const { signed, holder } = await buildSignedSecp();
    const opts = { ...happyOpts(holder), now: new Date("2026-05-19T23:00:00Z") };
    await expect(verifyVP(signed, opts)).rejects.toThrow(/maxFutureSkewMs/);
  });

  it.each(["expectedChallenge", "expectedDomain", "expectedHolder"] as const)(
    "rejects missing options.%s",
    async (field) => {
      const { signed, holder } = await buildSignedSecp();
      const opts = { ...happyOpts(holder), [field]: "" };
      await expect(verifyVP(signed, opts)).rejects.toThrow(new RegExp(field, "i"));
    }
  );

  // Pins the MaxVerifiableCredentials DoS bound — an unauthenticated
  // attacker submitting a large VC array would amplify URDNA2015 cost
  // into a queue-saturation DoS. The cap is gated before canonicalization
  // so the rejection cost stays O(parse).
  it("rejects an envelope exceeding maxVerifiableCredentials", async () => {
    const { signed, holder } = await buildSignedSecp();
    const vcs = signed.verifiableCredential as unknown[];
    const inflated = [...vcs, ...vcs, ...vcs, ...vcs, ...vcs];
    const big = { ...signed, verifiableCredential: inflated };
    const opts = { ...happyOpts(holder), maxVerifiableCredentials: 2 };
    await expect(verifyVP(big, opts)).rejects.toThrow(/maxVerifiableCredentials/);
  });

  // Pins the fail-closed-on-missing-now fix: previously, an undefined
  // `now` silently disabled all freshness checks (the verifier became a
  // no-freshness verifier with no signal). Now undefined is a hard reject.
  it("rejects undefined options.now (fail-closed freshness)", async () => {
    const { signed, holder } = await buildSignedSecp();
    const opts = { ...happyOpts(holder) } as Partial<VerifyVPOptions>;
    delete opts.now;
    await expect(
      verifyVP(signed, opts as VerifyVPOptions)
    ).rejects.toThrow(/options\.now is required/);
  });
});

describe("verifyVP: alternate issuer + multi-VC shapes", () => {
  it("accepts a VC.issuer as object form ({id, name, ...})", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const vc = fixtureVC(holder, {
      // Cast through unknown — the binding's `issuer` is `string |
      // {[k: string]: unknown}`, but TypeScript can't narrow that union
      // through the Partial<VerifiableCredential> overrides type.
      issuer: { id: "did:web:atumlabs.xyz", name: "Atum Labs" } as unknown as string,
    });
    const signed = await signVP([vc], wallet.privateKey, {
      holder,
      verificationMethod: `${holder}#blockchainAccountId`,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    });

    const opts: VerifyVPOptions = {
      ...happyOpts(holder),
      isIssuerTrusted: (did) => ({ allowed: did === "did:web:atumlabs.xyz", enforced: true }),
    };
    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, opts)
    ).resolves.toMatchObject({ cryptosuite: "EcdsaSecp256k1RecoverySignature2020" });
  });

  it("accepts multi-VC envelope where second VC declares the required type", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const genericVC = fixtureVC(holder, { type: ["VerifiableCredential"] });
    const knownVC = fixtureVC(holder);
    const signed = await signVP([genericVC, knownVC], wallet.privateKey, {
      holder,
      verificationMethod: `${holder}#blockchainAccountId`,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    });
    const res = await verifyVP(signed as unknown as Record<string, unknown>, happyOpts(holder));
    // The generic credential declares no reserved type, so it is passed
    // through rather than attested.
    expect(res.attestedClaims).toHaveLength(1);
    expect(res.passThroughClaims).toHaveLength(1);
  });
});

describe("verifyVP: signer/holder binding", () => {
  it("rejects when secp256k1 recovered signer does not match envelope.holder (attacker substitutes holder)", async () => {
    // Attacker scenario: a settler signs a VP with their own key, but
    // writes the victim's did:pkh as envelope.holder. Pre-fix, the
    // verifier only checked ExpectedHolder against envelope.holder
    // (caller-side consistency) — it never bound the recovered signer
    // back to the holder address segment, so a caller that read
    // ExpectedHolder from the same envelope would accept the forgery.
    const attacker = Wallet.createRandom();
    const victim = Wallet.createRandom();
    const victimHolder = `did:pkh:eip155:1:${victim.address.toLowerCase()}`;

    // Hand-build a wire envelope: attacker signs over canonical bytes
    // that include envelope.holder = victim's DID. signVP uses the
    // holder DID for the VM, so wire it up explicitly. The VC's
    // credentialSubject.id MUST equal the victim DID so the
    // subject-holder gate doesn't intercept before the outer signer-
    // holder mismatch fires — this test specifically pins the OUTER
    // mismatch, not the per-VC subject gate.
    const signed = await signVP([fixtureVC(victimHolder)], attacker.privateKey, {
      holder: victimHolder,
      verificationMethod: `${victimHolder}#blockchainAccountId`,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    });

    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, happyOpts(victimHolder))
    ).rejects.toThrow(/recovered secp256k1 signer .* does not match eip155 holder address/);
  });

  it("rejects when ed25519 verifier public key does not match envelope.holder (attacker substitutes holder)", async () => {
    // ed25519 mirror of the above. Attacker signs with their own seed
    // and uses their own verificationMethod (so nacl.sign.detached.verify
    // passes), but writes the victim's did:pkh as envelope.holder.
    const attackerKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    const victimKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
    const attackerPub = bs58.encode(Buffer.from(attackerKp.publicKey));
    const victimPub = bs58.encode(Buffer.from(victimKp.publicKey));
    const victimHolder = `did:pkh:solana:devnet:${victimPub}`;
    const attackerVM = `did:pkh:solana:devnet:${attackerPub}#blockchainAccountId`;

    const signed = (await signVPEd25519(
      [fixtureEd25519VC(victimHolder)],
      attackerKp.secretKey,
      {
        holder: victimHolder,
        verificationMethod: attackerVM,
        challenge: FIXTURE_CHALLENGE,
        domain: FIXTURE_DOMAIN,
        created: FIXTURE_CREATED,
      }
    )) as unknown as Record<string, unknown>;

    await expect(
      verifyVP(signed, happyOpts(victimHolder))
    ).rejects.toThrow(/recovered ed25519 pubkey .* does not match solana holder address/);
  });
});

describe("verifyVP: mixed-validity VC tier", () => {
  it("rejects a multi-VC envelope when any single VC fails the VALIDITY tier", async () => {
    // Pin the intentional asymmetry between the two tiers:
    //   VALIDITY (date window, issuer trust): ALL VCs must pass.
    //   POLICY  (required-type): at least one VC must match.
    // Mixed-VC fixture: one VC is in window, one is expired. The
    // POLICY tier (KnownToAtumVerifiableCredential) is satisfied by both, but the
    // VALIDITY tier MUST fail because one VC is past its
    // expirationDate. Errors that bypass the all-must-pass rule
    // would let an attacker dilute a stale/revoked credential by
    // bundling it with a fresh one.
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const freshVC = fixtureVC(holder, { id: "urn:uuid:vc-fresh" });
    const expiredVC = fixtureVC(holder, {
      id: "urn:uuid:vc-expired",
      expirationDate: "2026-05-19T00:00:00Z",
    } as Partial<VerifiableCredential>);
    const signed = await signVP([freshVC, expiredVC], wallet.privateKey, {
      holder,
      verificationMethod: `${holder}#blockchainAccountId`,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    });

    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, happyOpts(holder))
    ).rejects.toThrow(/verifiableCredential\[1\].*expired/);
  });
});

describe("verifyVP: proof['@context'] verbatim pass-through", () => {
  it("forwards an array-form proof['@context'] into canonicalization", async () => {
    // Inverse pin of the verbatim-@context fix. Mutate the wire
    // proof['@context'] to a foreign URL not in the local store; the
    // verifier MUST surface the foreign URL in the error rather than
    // silently substituting the canonical IRI.
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const signed = (await signVP([fixtureVC(holder)], wallet.privateKey, {
      holder,
      verificationMethod: `${holder}#blockchainAccountId`,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    })) as unknown as Record<string, unknown> & { proof: Record<string, unknown> };
    signed.proof["@context"] = "https://w3id.org/security/v2";

    await expect(
      verifyVP(signed, happyOpts(holder))
    ).rejects.toThrow(/w3id\.org\/security\/v2/);
  });
});

describe("verifyVP: holderEquals semantics", () => {
  it("accepts case-different did:pkh:<namespace>:<reference> prefix (W3C case-insensitive)", async () => {
    const wallet = Wallet.createRandom();
    const addr = wallet.address.toLowerCase();
    const holder = `did:pkh:eip155:1:${addr}`;
    const signed = await signVP([fixtureVC(holder)], wallet.privateKey, {
      holder,
      verificationMethod: `${holder}#blockchainAccountId`,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    });
    // Uppercase only the prefix; keep the address segment exact.
    const expected = `DID:PKH:EIP155:1:${addr}`;
    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, happyOpts(expected))
    ).resolves.toMatchObject({ cryptosuite: "EcdsaSecp256k1RecoverySignature2020" });
  });

  it("rejects a case-flipped Solana address segment (base58 is case-sensitive)", async () => {
    // Sign with a Solana-shaped did:pkh whose holder segment is real base58
    // mixed case. The verifier MUST reject when ExpectedHolder differs ONLY
    // in the address case — base58 ABCdef and abcDEF decode to different
    // accounts. Pre-fix this would silently match via toLowerCase compare.
    const wallet = Wallet.createRandom();
    const holderMixed =
      "did:pkh:solana:devnet:AbCdEfGhIjKlMnOpQrStUvWxYz123456789ABCDEFGH";
    const vm = `${holderMixed}#blockchainAccountId`;

    // Re-implement signQuote's body with the Solana-shaped VM. We can't use
    // signVP directly because it doesn't take a custom VM scheme outside
    // its option surface, and we need the wire holder to be the mixed-case
    // Solana DID to exercise the address-segment compare.
    const proofOptions = {
      type: "EcdsaSecp256k1RecoverySignature2020" as const,
      created: FIXTURE_CREATED,
      verificationMethod: vm,
      proofPurpose: "authentication" as const,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
    };
    const vpBody = {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://schemas.atum.network/declarations/FulfillmentQuoteEnvelope/v1/context.jsonld",
        "https://w3id.org/security/suites/secp256k1recovery-2020/v2",
      ],
      type: ["VerifiablePresentation"],
      holder: holderMixed,
      verifiableCredential: [fixtureVC(holderMixed)],
    };
    const { signingInput } = await (await import("./hash.js")).hashQuote(
      vpBody as unknown as Record<string, unknown>,
      {
        cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
        proofOptions,
        keepVerifiableCredential: true,
        proofContext: [
          "https://schemas.atum.network/declarations/FulfillmentQuoteEnvelope/v1/context.jsonld",
          "https://w3id.org/security/suites/secp256k1recovery-2020/v2",
        ],
      }
    );
    const { SigningKey } = await import("ethers");
    const sig = new SigningKey(wallet.privateKey).sign(signingInput);
    const { createDetachedJws } = await import("./jws.js");
    const jws = createDetachedJws(Buffer.from(sig.serialized.slice(2), "hex"));
    const signed: Record<string, unknown> = {
      ...vpBody,
      proof: { ...proofOptions, jws },
    };

    // Case-flipped address segment — different Solana account.
    const expected =
      "did:pkh:solana:devnet:aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789abcdefgh";
    await expect(verifyVP(signed, happyOpts(expected))).rejects.toThrow(
      /does not match ExpectedHolder/
    );
  });
});

// Correlation-ID rewrap + format gate. Mirror of the Go
// TestVerifyVP_CorrelationIDPrefixesError + TestVerifyVP_RejectsInvalidRequestID
// pair — both runtimes MUST behave identically.
describe("verifyVP: correlation-ID rewrap", () => {
  it("prefixes errors with [request_id=X] when options.requestId is set, preserves cause chain", async () => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const signed = await signVP([fixtureVC(holder)], wallet.privateKey, {
      holder,
      verificationMethod: `${holder}#blockchainAccountId`,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    });
    const opts: VerifyVPOptions = {
      ...happyOpts(holder),
      requestId: "req-42",
      expectedChallenge: "req-WRONG", // force a challenge mismatch
    };
    let caught: unknown;
    try {
      await verifyVP(signed as unknown as Record<string, unknown>, opts);
    } catch (e) {
      caught = e;
    }
    if (!(caught instanceof Error)) {
      throw new Error("verifyVP did not throw on mismatched challenge");
    }
    expect(caught.message).toMatch(/\[request_id=req-42\]/);
    // The original error stays reachable via .cause so callers can
    // still inspect what specifically failed (mirror of Go's errors.Is
    // sentinel preservation).
    const cause = (caught as Error).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(/challenge/);
  });

  // Pins the contract that verifyVP does NOT own the format of
  // options.requestId — the perimeter that supplies the value is
  // responsible for validating it. A regression that reintroduces a
  // format gate here would silently start rejecting legitimate proofs
  // with a misleading "proof malformed" message when the requester
  // perimeter evolves its id schema.
  it.each([
    "req-42",
    "5b5d7e0e-9d27-4f1f-a5db-3a52cfb24d2f",
    "prod_req.5b5d7e0e",
    "a".repeat(128),
    "a".repeat(256), // far past the old format gate's 128 cap
    "req with spaces", // not in the old charset
  ])("accepts any requestId shape (format owned by perimeter): %s", async (requestId) => {
    const wallet = Wallet.createRandom();
    const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
    const signed = await signVP([fixtureVC(holder)], wallet.privateKey, {
      holder,
      verificationMethod: `${holder}#blockchainAccountId`,
      challenge: FIXTURE_CHALLENGE,
      domain: FIXTURE_DOMAIN,
      created: FIXTURE_CREATED,
    });
    const opts: VerifyVPOptions = { ...happyOpts(holder), requestId };
    await expect(
      verifyVP(signed as unknown as Record<string, unknown>, opts)
    ).resolves.toMatchObject({ cryptosuite: "EcdsaSecp256k1RecoverySignature2020" });
  });

  it.each(["req-42", "5b5d7e0e-9d27-4f1f-a5db-3a52cfb24d2f", "prod_req.5b5d7e0e", "a".repeat(128)])(
    "accepts valid requestId shape: %s",
    async (requestId) => {
      const wallet = Wallet.createRandom();
      const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
      const signed = await signVP([fixtureVC(holder)], wallet.privateKey, {
        holder,
        verificationMethod: `${holder}#blockchainAccountId`,
        challenge: FIXTURE_CHALLENGE,
        domain: FIXTURE_DOMAIN,
        created: FIXTURE_CREATED,
      });
      const opts: VerifyVPOptions = { ...happyOpts(holder), requestId };
      await expect(
        verifyVP(signed as unknown as Record<string, unknown>, opts)
      ).resolves.toMatchObject({ cryptosuite: "EcdsaSecp256k1RecoverySignature2020" });
    }
  );
});
