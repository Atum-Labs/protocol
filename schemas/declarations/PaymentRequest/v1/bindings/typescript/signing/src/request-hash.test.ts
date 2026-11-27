// Unit tests for computeRequestHash. Mirror of request_hash_test.go in the Go
// ld-verification package — same invariants pinned on both sides: stable
// uniform output, PURE CONTENT (ignores the inner proof + created + signature
// material), the signed-message-signature strip vs message_prehash/message
// preservation, credential-carrier inertness, the anti-replay request_id
// invariant, suite-independence, and the accept/reject boundary.

import { describe, it, expect } from "vitest";

import { computeRequestHash } from "./request-hash.js";
import {
  PAYMENT_REQUEST_CONTEXT_URL,
  SECP256K1_RECOVERY_CONTEXT_URL,
} from "./canonicalize.js";

// request_hash is keccak256(docHash) → uniformly 32 bytes → "0x" + 64 hex.
const REQUEST_HASH_PATTERN = /^0x[0-9a-f]{64}$/;

function baseRequest(): Record<string, any> {
  return {
    "@context": [PAYMENT_REQUEST_CONTEXT_URL, SECP256K1_RECOVERY_CONTEXT_URL],
    version: "1.0",
    request_id: "req-pr-secp-1",
    fulfillment_amount: "1000000",
    // quote_deadline, fulfillment_deadline, fulfillment_verifier and
    // escrow_contract_address are required top-level fields, so
    // computeRequestHash rejects a body missing them.
    quote_deadline: "2030-01-01T00:00:00Z",
    fulfillment_deadline: "2030-01-02T00:00:00Z",
    escrow_contract_address: "0x0000000000000000000000000000000000000003",
    fulfillment_verifier: {
      account: "0x0000000000000000000000000000000000000004",
      endpoint: "https://veri-fill.example.com",
    },
    source: {
      account: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      asset_identifier:
        "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A",
    },
    destination: [
      {
        account: "0x0000000000000000000000000000000000000002",
        asset_identifier: "eip155:1/erc20:0xbbb",
      },
    ],
    sender_auth: {
      message_scheme: "EVM_PERMIT2",
      signed_messages: [
        {
          message:
            "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
          message_prehash: "0xdeadbeef",
          signature: "0xabcdef1234567890",
        },
      ],
    },
    proof: {
      type: "EcdsaSecp256k1RecoverySignature2020",
      created: "2026-04-01T00:00:00.000Z",
      verificationMethod:
        "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266#blockchainAccountId",
      proofPurpose: "assertionMethod",
      jws: "eyJhbGciOiJFUzI1NkstUiJ9..signaturematerial",
    },
  };
}

const hashOf = (m: Record<string, unknown>) => computeRequestHash(m);

describe("computeRequestHash: deterministic + uniform shape", () => {
  it("stable across calls, uniform 32-byte 0x-hex", async () => {
    const h1 = await hashOf(baseRequest());
    const h2 = await hashOf(baseRequest());
    expect(h1).toMatch(REQUEST_HASH_PATTERN);
    expect(h2).toBe(h1);
  });

  it("accepts an already-parsed object equivalently to its JSON string", async () => {
    const obj = baseRequest();
    const fromObject = await computeRequestHash(obj);
    const fromString = await computeRequestHash(JSON.stringify(obj));
    expect(fromString).toBe(fromObject);
  });
});

// PURE CONTENT: the hash must NOT depend on the inner PR's own proof — neither
// its presence, its created, nor its signature material.
describe("computeRequestHash: ignores the inner proof (pure content)", () => {
  it("unchanged when proof deleted / created mutated / jws tampered", async () => {
    const base = await hashOf(baseRequest());

    const noProof = baseRequest();
    delete noProof.proof;
    expect(await hashOf(noProof)).toBe(base);

    const mutCreated = baseRequest();
    mutCreated.proof.created = "2099-12-31T23:59:59.000Z";
    expect(await hashOf(mutCreated)).toBe(base);

    const mutJws = baseRequest();
    mutJws.proof.jws = "tampered";
    expect(await hashOf(mutJws)).toBe(base);
  });
});

describe("computeRequestHash: signed-message strip vs preserve", () => {
  it("strips signature; preserves message_prehash + message", async () => {
    const base = await hashOf(baseRequest());

    const mutSig = baseRequest();
    mutSig.sender_auth.signed_messages[0].signature = "0xdifferentsignature";
    expect(await hashOf(mutSig)).toBe(base);

    const mutPrehash = baseRequest();
    mutPrehash.sender_auth.signed_messages[0].message_prehash = "0xcafebabe";
    expect(await hashOf(mutPrehash)).not.toBe(base);

    const mutMsg = baseRequest();
    mutMsg.sender_auth.signed_messages[0].message = "0x0000";
    expect(await hashOf(mutMsg)).not.toBe(base);
  });
});

// Splicing the PRE presentation / originator_auth / verifiableCredential /
// nested sender_auth.verifiable_credential onto the wire PaymentRequest must be
// inert — this is the asymmetry that previously diverged TS from Go.
describe("computeRequestHash: strips all credential carriers", () => {
  it("presentation/originator_auth/verifiableCredential/sender_auth.vc are inert", async () => {
    const base = await hashOf(baseRequest());

    const validVC = {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      id: "urn:uuid:9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
      type: ["VerifiableCredential"],
      issuer: "did:web:spliced.example",
      issuanceDate: "2026-01-01T00:00:00Z",
      credentialSubject: {
        id: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      },
      proof: {
        type: "EcdsaSecp256k1RecoverySignature2020",
        created: "2026-01-01T00:00:00Z",
        verificationMethod: "did:web:spliced.example#key-1",
        proofPurpose: "assertionMethod",
        jws: "ey..vc",
      },
    };
    const validVCAuth = {
      signature: "0xsig",
      verification_method_id: "did:web:spliced.example#key-1",
      verifiable_credential: validVC,
    };

    const withCarriers = baseRequest();
    withCarriers.presentation = {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      type: ["VerifiablePresentation", "PaymentRequestEnvelope"],
      holder: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      verifiableCredential: [validVC],
      proof: {
        type: "EcdsaSecp256k1RecoverySignature2020",
        created: "2026-04-01T00:00:00Z",
        verificationMethod:
          "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266#blockchainAccountId",
        proofPurpose: "authentication",
        challenge: "req-pr-secp-1",
        domain: "did:web:devnet.atum.network",
        jws: "ey..pre",
      },
    };
    withCarriers.verifiableCredential = [validVC];
    withCarriers.originator_auth = validVCAuth;
    withCarriers.sender_auth.verifiable_credential = validVCAuth;

    expect(await hashOf(withCarriers)).toBe(base);
  });
});

// THE anti-replay invariant: request_hash is safe as a replay challenge only
// because request_id is in the hashed content.
describe("computeRequestHash: content sensitivity", () => {
  it("changes when request_id changes (anti-replay invariant)", async () => {
    const base = await hashOf(baseRequest());
    const mut = baseRequest();
    mut.request_id = "req-pr-secp-2";
    expect(await hashOf(mut)).not.toBe(base);
  });

  it("keeps the hash when executor is absent and changes it when executor is present", async () => {
    const base = await hashOf(baseRequest());
    const omitted = baseRequest();
    delete omitted.executor;
    expect(await hashOf(omitted)).toBe(base);
    const present = baseRequest();
    present.executor = "settler";
    expect(await hashOf(present)).not.toBe(base);
    const split = baseRequest();
    split.executor = { deposit: "settler", reserve: "settler", fulfill: "originator" };
    expect(await hashOf(split)).not.toBe(base);
  });

  // Mirrors TestComputeRequestHash_DepositNonceChangesIt: before the context defined the term,
  // JSON-LD dropped it and every nonce hashed alike.
  it("changes with the deposit nonce of an originator-executed deposit", async () => {
    const withNonce = (nonce?: string) => {
      const doc = baseRequest();
      delete doc.sender_auth;
      doc.executor = { deposit: "originator", reserve: "settler", fulfill: "originator" };
      if (nonce !== undefined) doc.deposit_nonce = nonce;
      return doc;
    };
    const without = await hashOf(withNonce());
    const seven = await hashOf(withNonce("7"));
    const eight = await hashOf(withNonce("8"));
    expect(seven).not.toBe(without);
    expect(seven).not.toBe(eight);
  });

  it("changes when fulfillment_amount changes", async () => {
    const base = await hashOf(baseRequest());
    const mut = baseRequest();
    mut.fulfillment_amount = "2000000";
    expect(await hashOf(mut)).not.toBe(base);
  });
});

// Suite-independence: same content signed under ed25519 vs secp256k1 → same
// request_hash (request_hash pins a fixed suite for the docHash path).
describe("computeRequestHash: suite independence", () => {
  it("ed25519-signed content hashes identically to secp256k1", async () => {
    const base = await hashOf(baseRequest());
    const ed = baseRequest();
    ed.proof.type = "Ed25519Signature2020";
    ed.proof.proofValue = "z3rawed25519proofvalue";
    delete ed.proof.jws;
    expect(await hashOf(ed)).toBe(base);
  });
});

describe("computeRequestHash: rejects malformed input", () => {
  it.each(["fulfillment_verifier", "escrow_contract_address"])(
    "missing %s throws",
    async (field) => {
      const doc = baseRequest();
      delete doc[field];
      await expect(computeRequestHash(doc)).rejects.toThrow(
        `missing required field ${field}`
      );
    }
  );

  // schema.json does not require sender_auth (an originator-executed deposit and a quote request
  // carry none), and the Go typed parse regenerated from it accepts such a request.
  it("hashes a request without sender_auth, as Go does", async () => {
    const doc = baseRequest();
    delete doc.sender_auth;
    await expect(computeRequestHash(doc)).resolves.toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("missing required field throws", async () => {
    await expect(computeRequestHash({ version: "1.0" })).rejects.toThrow(
      /missing required field/
    );
  });
});
