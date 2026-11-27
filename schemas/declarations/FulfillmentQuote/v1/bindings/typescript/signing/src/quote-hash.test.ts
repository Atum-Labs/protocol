// Unit tests for computeQuoteHash. Mirror of quote_hash_test.go in the Go
// ld-verification package — same properties pinned on both sides: stable
// uniform-length output, the signingInput-not-docHash guard, signature-
// material independence, and the accept/reject boundary.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { computeQuoteHash } from "./quote-hash.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../../../../conformance/fixtures");

function readFixture(name: string): string {
  return readFileSync(resolve(fixturesDir, name), "utf-8");
}

// quote_hash is keccak256(signingInput) for every cryptosuite, so it is
// uniformly 32 bytes → "0x" + 64 lowercase hex nibbles.
const QUOTE_HASH_PATTERN = /^0x([0-9a-f]{2})+$/;
const QUOTE_HASH_LEN = 2 + 64;

describe("computeQuoteHash: deterministic output + uniform shape", () => {
  for (const fixture of ["secp256k1-go-signed.json", "ed25519-go-signed.json"]) {
    it(`${fixture}: stable across calls, uniform 32-byte 0x-hex`, async () => {
      const signed = readFixture(fixture);

      const first = await computeQuoteHash(signed);
      expect(first).toMatch(QUOTE_HASH_PATTERN);
      expect(first).toHaveLength(QUOTE_HASH_LEN);

      const second = await computeQuoteHash(signed);
      expect(second).toBe(first);
    });
  }

  it("accepts an already-parsed object equivalently to its JSON string", async () => {
    const signed = readFixture("secp256k1-go-signed.json");
    const fromString = await computeQuoteHash(signed);
    const fromObject = await computeQuoteHash(JSON.parse(signed));
    expect(fromObject).toBe(fromString);
  });
});

// signingInput-not-docHash guard: the only difference is proof.created;
// because the signing input folds in the proof hash (which commits to
// created), the quote_hashes MUST differ.
describe("computeQuoteHash: content identity", () => {
  it("changes when only proof.created changes", async () => {
    const signed = readFixture("secp256k1-go-signed.json");
    const original = await computeQuoteHash(signed);

    const doc = JSON.parse(signed) as Record<string, unknown>;
    (doc.proof as Record<string, unknown>).created = "2099-01-01T00:00:00Z";

    expect(await computeQuoteHash(doc)).not.toBe(original);
  });
});

// Security-relevant property: the hash never reads proof.jws / proof.proofValue,
// so tampering with the (attacker-replaceable) signature bytes leaves quote_hash
// unchanged — which is why an equal quote_hash does NOT imply a valid signature.
describe("computeQuoteHash: ignores signature material", () => {
  it("secp256k1: unchanged when proof.jws is tampered", async () => {
    const signed = readFixture("secp256k1-go-signed.json");
    const base = await computeQuoteHash(signed);

    const doc = JSON.parse(signed) as Record<string, unknown>;
    (doc.proof as Record<string, unknown>).jws =
      "eyJ0YW1wZXJlZCI6dHJ1ZX0.tampered.signature";

    expect(await computeQuoteHash(doc)).toBe(base);
  });

  it("ed25519: unchanged when proof.proofValue is tampered", async () => {
    const signed = readFixture("ed25519-go-signed.json");
    const base = await computeQuoteHash(signed);

    const doc = JSON.parse(signed) as Record<string, unknown>;
    (doc.proof as Record<string, unknown>).proofValue =
      "z3TamperedSignatureValueThatIsNotReal";

    expect(await computeQuoteHash(doc)).toBe(base);
  });
});

describe("computeQuoteHash: error paths", () => {
  it("rejects malformed JSON", async () => {
    await expect(computeQuoteHash("{not json")).rejects.toThrow();
  });

  it("rejects a quote missing a required top-level field", async () => {
    // Direction-A boundary: mirrors Go's typed-parse required-field rejection.
    const doc = JSON.parse(readFixture("secp256k1-go-signed.json")) as Record<
      string,
      unknown
    >;
    delete doc.source_amount;
    await expect(computeQuoteHash(doc)).rejects.toThrow(/missing required field/);
  });

  it("rejects a quote with no proof block", async () => {
    const doc = JSON.parse(readFixture("secp256k1-go-signed.json")) as Record<
      string,
      unknown
    >;
    delete doc.proof;
    await expect(computeQuoteHash(doc)).rejects.toThrow(/missing proof/);
  });

  it("rejects an empty proof field", async () => {
    // Direction-B boundary: present-but-empty proof string is rejected.
    const doc = JSON.parse(readFixture("secp256k1-go-signed.json")) as Record<
      string,
      unknown
    >;
    (doc.proof as Record<string, unknown>).proofPurpose = "";
    await expect(computeQuoteHash(doc)).rejects.toThrow();
  });

  it("rejects an unsupported proof.type", async () => {
    const doc = JSON.parse(readFixture("secp256k1-go-signed.json")) as Record<
      string,
      unknown
    >;
    (doc.proof as Record<string, unknown>).type = "SomeUnknownSignature2099";
    await expect(computeQuoteHash(doc)).rejects.toThrow(/unsupported proof\.type/);
  });
});
