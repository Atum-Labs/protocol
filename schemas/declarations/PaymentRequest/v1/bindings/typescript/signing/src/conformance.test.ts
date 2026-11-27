import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import bs58 from "bs58";

import { verifyPaymentRequest } from "./verify.js";
import { computeRequestHash } from "./request-hash.js";

// Cross-language conformance for the PaymentRequest/v1 LD signing
// libraries — the TS ⇐ Go leg. The contract these tests pin:
//
//  1. A request signed by the Go signer verifies on the TS side with the
//     expected recovered identity.
//  2. The reverse holds — covered by the Go-side conformance_test.go.
//  3. Ed25519 signatures are deterministic (RFC 8032), so the Go-signed
//     and TS-signed ed25519 fixtures MUST be byte-identical.
//
// Mirror of the FulfillmentQuote conformance.test.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../../../../conformance/fixtures");

function readFixture(name: string): string {
  return readFileSync(resolve(fixturesDir, name), "utf-8");
}

const PINNED_CREATED = "2026-04-01T00:00:00.000Z";
// Hardhat account #0.
const HARDHAT_ACCOUNT_0 = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
// Ed25519 pubkey from the all-zero 32-byte seed (hex of the RFC 8032
// "key A" vector pubkey).
const ZERO_SEED_PUB_HEX =
  "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("PaymentRequest conformance: TS verifies Go-signed", () => {
  it("verifies the Go-signed secp256k1 fixture", async () => {
    const res = await verifyPaymentRequest(readFixture("secp256k1-go-signed.json"));
    expect(res.cryptosuite).toBe("EcdsaSecp256k1RecoverySignature2020");
    expect(res.signerAddress).toBe(HARDHAT_ACCOUNT_0);
    expect(res.created.toISOString()).toBe(PINNED_CREATED);
  });

  // The typed form a wallet signs, by the Go signer: an EIP-712 signature over
  // PaymentRequestProof{proofHash, docHash} of the same document.
  it("verifies the Go-signed typed secp256k1 fixture where the typed form is accepted, and only there", async () => {
    await expect(verifyPaymentRequest(readFixture("secp256k1-typed-go-signed.json"))).rejects.toThrow(/altered/);
    const res = await verifyPaymentRequest(readFixture("secp256k1-typed-go-signed.json"), {
      acceptPaymentRequestTypedProof: true,
    });
    expect(res.cryptosuite).toBe("EcdsaSecp256k1RecoverySignature2020");
    expect(res.signerAddress).toBe(HARDHAT_ACCOUNT_0);
    expect(res.created.toISOString()).toBe(PINNED_CREATED);
    expect(readFixture("secp256k1-typed-go-signed.json")).not.toBe(readFixture("secp256k1-go-signed.json"));
  });

  it("verifies the Go-signed ed25519 fixture", async () => {
    const res = await verifyPaymentRequest(readFixture("ed25519-go-signed.json"));
    expect(res.cryptosuite).toBe("Ed25519Signature2020");
    expect(res.ed25519PublicKey).not.toBeNull();
    expect(toHex(res.ed25519PublicKey as Uint8Array)).toBe(ZERO_SEED_PUB_HEX);
    expect(res.didNetwork).toBe("devnet");
    expect(res.created.toISOString()).toBe(PINNED_CREATED);
  });
});

describe("PaymentRequest conformance: ed25519 byte-identity", () => {
  it("Go-signed and TS-signed ed25519 fixtures are byte-identical", () => {
    const goSigned = readFixture("ed25519-go-signed.json");
    const tsSigned = readFixture("ed25519-ts-signed.json");
    expect(tsSigned).toBe(goSigned);
  });
});

// Sanity: the base58 pubkey embedded in the ed25519 fixtures matches the
// well-known zero-seed pubkey, so a regression in seed handling fires
// here rather than silently producing a different (still self-consistent)
// fixture.
describe("PaymentRequest conformance: pinned ed25519 identity", () => {
  it("ed25519-go-signed embeds the zero-seed Solana pubkey", () => {
    const doc = JSON.parse(readFixture("ed25519-go-signed.json"));
    const vm: string = doc.proof.verificationMethod;
    const pubBase58 = vm.replace("did:pkh:solana:devnet:", "").replace("#blockchainAccountId", "");
    expect(toHex(bs58.decode(pubBase58))).toBe(ZERO_SEED_PUB_HEX);
  });
});

// The Stellar pair: one request signed under the zero seed by each signer, byte-identical like the
// Solana pair. Mirror of TestConformance_StellarFixtures in stellar_test.go.
describe("PaymentRequest conformance: stellar ed25519", () => {
  const ACCOUNT = "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH";

  it("Go-signed and TS-signed Stellar fixtures are byte-identical", () => {
    expect(readFixture("ed25519-stellar-ts-signed.json")).toBe(readFixture("ed25519-stellar-go-signed.json"));
  });

  it("verifies, and names the zero-seed key under the stellar namespace", async () => {
    const res = await verifyPaymentRequest(readFixture("ed25519-stellar-go-signed.json"));
    expect(res.cryptosuite).toBe("Ed25519Signature2020");
    expect(toHex(res.ed25519PublicKey as Uint8Array)).toBe(ZERO_SEED_PUB_HEX);
    expect(res.didNetwork).toBe("testnet");
    expect(res.signerDID).toBe(`did:pkh:stellar:testnet:${ACCOUNT}`);
  });

  // The Solana fixture's DID names the solana namespace; a caller binding namespace and network
  // together can tell it from the Stellar one.
  it("the Solana fixture's signerDID carries the other namespace", async () => {
    const res = await verifyPaymentRequest(readFixture("ed25519-go-signed.json"));
    expect(res.signerDID.split(":")[2]).toBe("solana");
  });
});

// computeRequestHash reproduces the committed golden for every fixture; the Go
// conformance_test.go (TestConformance_RequestHashMatchesGolden) asserts the
// same golden from ComputeRequestHash. Both matching this one committed file is
// what pins Go↔TS request_hash parity. request_hash is PURE CONTENT (strips the
// inner proof + signed-message signatures, fixed secp suite), so go-signed and
// ts-signed of a suite collide and secp differs from ed25519. Rebaseline: see
// conformance/README.md.
describe("conformance: content-addressed request_hash parity (Go↔TS golden)", () => {
  const golden = JSON.parse(
    readFileSync(resolve(fixturesDir, "..", "request-hash-golden.json"), "utf-8")
  ) as Record<string, string>;

  for (const name of [
    "secp256k1-go-signed.json",
    "secp256k1-ts-signed.json",
    "ed25519-go-signed.json",
    "ed25519-ts-signed.json",
  ]) {
    it(`${name}: computeRequestHash matches the committed golden`, async () => {
      const got = await computeRequestHash(readFixture(name));
      expect(got).toBe(golden[name]);
    });
  }
});

// An originator-executed deposit's request carries deposit_nonce, a term the context defines so
// request_hash covers it. Mirrors TestConformance_RequestHashOfADirectDepositMatchesGolden.
describe("conformance: request_hash of an originator-executed deposit (Go<->TS golden)", () => {
  it("computeRequestHash matches the committed golden", async () => {
    const golden = JSON.parse(
      readFileSync(resolve(fixturesDir, "..", "request-hash-direct-deposit-golden.json"), "utf-8")
    ) as { request: string; want: string };
    expect(await computeRequestHash(JSON.parse(golden.request))).toBe(golden.want);
  });
});
