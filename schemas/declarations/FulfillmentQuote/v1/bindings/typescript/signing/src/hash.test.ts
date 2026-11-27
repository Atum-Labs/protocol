import { describe, it, expect } from "vitest";

import { hashQuote, type HashableProofOptions } from "./hash.js";
import { SECP256K1_RECOVERY_CONTEXT_URL } from "./canonicalize.js";

// fixtureQuote mirrors the Go suite's fixtureQuote exactly so a future
// cross-language fixture lock can byte-compare hexes without
// first reconciling fixture shapes. `version` is omitted on purpose:
// it gives the version-participates-in-hash test below a clean baseline
// to diff against. The test uses fixtureQuoteWithVersion to prove the
// version binding carries the version triple through
// URDNA2015 and into the signing input.
function fixtureQuote(): Record<string, unknown> {
  return {
    source_amount: "1000000",
    award_deadline: "2030-01-01T00:00:00Z",
    source: {
      id: "eip155:1/erc20:0xaaa",
      account: "eip155:1:0x1",
    },
    destination: {
      id: "eip155:1/erc20:0xbbb",
      account: "eip155:1:0x2",
    },
    settler_address: "0xsettler",
    payment_request_json: '{"request_id":"req-1"}',
  };
}

// fixtureQuoteWithVersion is fixtureQuote + `version: "1.0"`. Before the
// FulfillmentQuote @context bound `atum:version`, URDNA2015
// silently dropped this field — the failure mode this test guards
// (cross-stack signer recovery returned a random-looking address
// because the verifier's canonical hash differed from the signer's). With
// the binding now live on main, this fixture's hash MUST differ from
// fixtureQuote()'s; the dedicated test below pins exactly that.
function fixtureQuoteWithVersion(): Record<string, unknown> {
  return { ...fixtureQuote(), version: "1.0" };
}

function fixtureSecp256k1ProofOpts(): HashableProofOptions {
  return {
    type: "EcdsaSecp256k1RecoverySignature2020",
    created: "2026-04-01T00:00:00.000Z",
    verificationMethod: "did:pkh:eip155:1:0xabc#blockchainAccountId",
    proofPurpose: "assertionMethod",
  };
}

function fixtureEd25519ProofOpts(): HashableProofOptions {
  return {
    type: "Ed25519Signature2020",
    created: "2026-04-01T00:00:00.000Z",
    verificationMethod:
      "did:pkh:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:5fhUhdoXJ24Kk8X3kZw4DqZsbpoeD3RKj5RX7CY4hH5h#blockchainAccountId",
    proofPurpose: "assertionMethod",
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("hashQuote: determinism", () => {
  it("secp256k1: same input produces the same SigningInput and intermediate hashes", async () => {
    const a = await hashQuote(fixtureQuote(), {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions: fixtureSecp256k1ProofOpts(),
    });
    const b = await hashQuote(fixtureQuote(), {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions: fixtureSecp256k1ProofOpts(),
    });
    expect(bytesEqual(a.signingInput, b.signingInput)).toBe(true);
    expect(bytesEqual(a.docHash, b.docHash)).toBe(true);
    expect(bytesEqual(a.proofHash, b.proofHash)).toBe(true);
  });

  it("ed25519: same input produces the same SigningInput", async () => {
    const a = await hashQuote(fixtureQuote(), {
      cryptosuite: "Ed25519Signature2020",
      proofOptions: fixtureEd25519ProofOpts(),
    });
    const b = await hashQuote(fixtureQuote(), {
      cryptosuite: "Ed25519Signature2020",
      proofOptions: fixtureEd25519ProofOpts(),
    });
    expect(bytesEqual(a.signingInput, b.signingInput)).toBe(true);
  });
});

describe("hashQuote: output shape", () => {
  it("secp256k1: keccak256 yields 32-byte hashes; combined keccak256 yields 32-byte SigningInput", async () => {
    const res = await hashQuote(fixtureQuote(), {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions: fixtureSecp256k1ProofOpts(),
    });
    expect(res.cryptosuite).toBe("EcdsaSecp256k1RecoverySignature2020");
    expect(res.docHash.length).toBe(32);
    expect(res.proofHash.length).toBe(32);
    expect(res.signingInput.length).toBe(32);
  });

  it("ed25519: SHA-256 yields 32-byte hashes; raw concat yields 64-byte SigningInput", async () => {
    const res = await hashQuote(fixtureQuote(), {
      cryptosuite: "Ed25519Signature2020",
      proofOptions: fixtureEd25519ProofOpts(),
    });
    expect(res.cryptosuite).toBe("Ed25519Signature2020");
    expect(res.docHash.length).toBe(32);
    expect(res.proofHash.length).toBe(32);
    expect(res.signingInput.length).toBe(64);
  });
});

// Guards against a refactor that accidentally collapses the cryptosuite
// branches. Both suites canonicalize against different proof contexts
// AND use different hash primitives, so their outputs MUST differ.
describe("hashQuote: cryptosuite discrimination", () => {
  it("secp256k1 and ed25519 produce different SigningInput for the same document", async () => {
    const q = fixtureQuote();
    const secp = await hashQuote(q, {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions: fixtureSecp256k1ProofOpts(),
    });
    const ed = await hashQuote(q, {
      cryptosuite: "Ed25519Signature2020",
      proofOptions: fixtureEd25519ProofOpts(),
    });
    expect(bytesEqual(secp.signingInput, ed.signingInput)).toBe(false);
  });
});

describe("hashQuote: error paths", () => {
  it("rejects an unsupported cryptosuite", async () => {
    await expect(
      hashQuote(fixtureQuote(), {
        cryptosuite: "EcdsaSecp256k1Signature2019" as never,
        proofOptions: {
          type: "EcdsaSecp256k1Signature2019",
          created: "",
          verificationMethod: "",
          proofPurpose: "",
        } as never,
      })
    ).rejects.toThrow(/unsupported cryptosuite/i);
  });

  it("rejects proofOptions.type != cryptosuite (typo guard)", async () => {
    const po = fixtureSecp256k1ProofOpts();
    po.type = "Ed25519Signature2020";
    await expect(
      hashQuote(fixtureQuote(), {
        cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
        proofOptions: po,
      })
    ).rejects.toThrow(/must match cryptosuite/i);
  });
});

// Proves the input strip is load-bearing: feeding hashQuote a document
// with a stale proof block MUST produce the same SigningInput as the
// equivalent stripped document. Without the strip, a re-sign caller
// would canonicalize the stale proof's predicates into the hash.
describe("hashQuote: strips proof and verifiableCredential", () => {
  it("stale proof + verifiableCredential carryover does not change the hash", async () => {
    const bare = fixtureQuote();
    const withCarryover = fixtureQuote();
    withCarryover.proof = {
      type: "EcdsaSecp256k1RecoverySignature2020",
      created: "1999-01-01T00:00:00Z",
      verificationMethod: "did:example:stale",
      proofPurpose: "assertionMethod",
      jws: "stale..signature",
    };
    withCarryover.verifiableCredential = [];

    const a = await hashQuote(bare, {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions: fixtureSecp256k1ProofOpts(),
    });
    const b = await hashQuote(withCarryover, {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions: fixtureSecp256k1ProofOpts(),
    });
    expect(bytesEqual(a.signingInput, b.signingInput)).toBe(true);
  });
});

// The security pin: any change to a load-bearing field MUST alter
// SigningInput. We already cover end-to-end tamper rejection at the
// verify level; this pins the boundary at hashQuote itself so a
// canonicalization refactor that moved bytes around can't silently
// fail-open.
describe("hashQuote: tampering changes the hash", () => {
  const mutations: Array<{
    name: string;
    mutate: (q: Record<string, unknown>, p: HashableProofOptions) => void;
  }> = [
    { name: "source_amount", mutate: (q) => { q.source_amount = "999"; } },
    { name: "award_deadline", mutate: (q) => { q.award_deadline = "2099-12-31T23:59:59Z"; } },
    { name: "settler_address", mutate: (q) => { q.settler_address = "0xother"; } },
    { name: "proof.created", mutate: (_q, p) => { p.created = "2099-01-01T00:00:00Z"; } },
    {
      name: "proof.verificationMethod",
      mutate: (_q, p) => {
        p.verificationMethod = "did:pkh:eip155:1:0xother#blockchainAccountId";
      },
    },
  ];

  for (const tc of mutations) {
    it(`mutating ${tc.name} changes SigningInput`, async () => {
      const base = await hashQuote(fixtureQuote(), {
        cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
        proofOptions: fixtureSecp256k1ProofOpts(),
      });

      const q = fixtureQuote();
      const p = fixtureSecp256k1ProofOpts();
      tc.mutate(q, p);
      const res = await hashQuote(q, {
        cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
        proofOptions: p,
      });
      expect(bytesEqual(base.signingInput, res.signingInput)).toBe(false);
    });
  }
});

// Proves the verbatim-@context pass-through is operative: when a caller
// supplies a proof context that's structurally different from the
// canonical IRI (e.g. a single-element array of the same URL), URDNA2015
// normalizes to the same n-quads — but only because hashQuote forwarded
// the value rather than substituting a synthesized default. A regression
// that re-hardcoded the IRI would also pass that case (because the wire
// form happens to equal the default), so the inverse — a *different*
// IRI shape — is what proves pass-through, not equality.
describe("hashQuote: proofContext override preserves byte identity", () => {
  it("array form of the canonical IRI produces the same SigningInput as the string form", async () => {
    const opts = {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020" as const,
      proofOptions: fixtureSecp256k1ProofOpts(),
    };
    const canonical = await hashQuote(fixtureQuote(), opts);
    const matched = await hashQuote(fixtureQuote(), {
      ...opts,
      proofContext: [SECP256K1_RECOVERY_CONTEXT_URL],
    });
    expect(bytesEqual(canonical.signingInput, matched.signingInput)).toBe(true);
  });

  it("a foreign @context URL surfaces as a canonicalize-side error (proving pass-through)", async () => {
    await expect(
      hashQuote(fixtureQuote(), {
        cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
        proofOptions: fixtureSecp256k1ProofOpts(),
        // Not in the embedded context store. A silent substitution to
        // the canonical default would have succeeded; this rejection IS
        // the pass-through proof.
        proofContext: "https://w3id.org/security/v2",
      })
    ).rejects.toThrow(/https:\/\/w3id\.org\/security\/v2/);
  });
});

// hashQuote: version participates in the signing input pins the version
// binding — the FulfillmentQuote @context now binds `atum:version`, so a
// document with a version field MUST hash differently than the equivalent
// document without one. The inverse — equal hashes — would mean URDNA2015
// dropped the field, the same failure mode a drift check guards against.
// This catches
// the same regression at the canonicalization step, in-language, no
// cross-repo coupling required.
//
// Both cryptosuites because the version field lives in the document, not
// the proof block: a regression that only affected one suite's
// document-hashing path would slip past a single-suite test. Mirror of
// TestHashQuote_VersionParticipatesInHash on the Go side.
describe("hashQuote: version participates in the signing input", () => {
  it("secp256k1: version field changes the SigningInput", async () => {
    const baseline = await hashQuote(fixtureQuote(), {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions: fixtureSecp256k1ProofOpts(),
    });
    const withVersion = await hashQuote(fixtureQuoteWithVersion(), {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions: fixtureSecp256k1ProofOpts(),
    });
    if (bytesEqual(baseline.signingInput, withVersion.signingInput)) {
      throw new Error(
        "version field did not change signingInput — @context binding for atum:version regressed"
      );
    }
  });

  it("ed25519: version field changes the SigningInput", async () => {
    const baseline = await hashQuote(fixtureQuote(), {
      cryptosuite: "Ed25519Signature2020",
      proofOptions: fixtureEd25519ProofOpts(),
    });
    const withVersion = await hashQuote(fixtureQuoteWithVersion(), {
      cryptosuite: "Ed25519Signature2020",
      proofOptions: fixtureEd25519ProofOpts(),
    });
    if (bytesEqual(baseline.signingInput, withVersion.signingInput)) {
      throw new Error(
        "version field did not change signingInput — @context binding for atum:version regressed"
      );
    }
  });
});
