import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  computeAwardHash,
  AWARD_HASH_DOMAIN_SEPARATOR,
} from "./award-hash.js";

// The frozen cross-language contract shared with the Go binding
// (signing/go). conformance/ is three levels up from src/:
// src -> typescript -> signing -> v1.
const __dirname = dirname(fileURLToPath(import.meta.url));
const goldenPath = resolve(
  __dirname,
  "../../../../conformance/award-hash-golden.json",
);

interface GoldenCase {
  name: string;
  payment_id: string;
  quote_hash: string;
  settler_id: string;
  award_hash: string;
}
interface Golden {
  domain_separator: string;
  cases: GoldenCase[];
}

const golden: Golden = JSON.parse(readFileSync(goldenPath, "utf8"));

describe("award_hash golden conformance", () => {
  it("has cases", () => {
    expect(golden.cases.length).toBeGreaterThan(0);
  });

  it("domain separator matches the frozen contract", () => {
    expect(AWARD_HASH_DOMAIN_SEPARATOR).toBe(golden.domain_separator);
  });

  for (const c of golden.cases) {
    it(`reproduces golden vector: ${c.name}`, () => {
      expect(computeAwardHash(c.payment_id, c.quote_hash, c.settler_id)).toBe(
        c.award_hash,
      );
    });
  }
});

describe("award_hash input validation", () => {
  it("rejects empty fields", () => {
    expect(() => computeAwardHash("", "0xq", "s")).toThrow();
    expect(() => computeAwardHash("0xp", "", "s")).toThrow();
    expect(() => computeAwardHash("0xp", "0xq", "")).toThrow();
  });

  it("rejects newline injection", () => {
    expect(() => computeAwardHash("0xp\n", "0xq", "s")).toThrow();
    expect(() => computeAwardHash("0xp", "0xq", "s\n1")).toThrow();
  });

  it("binds every field and rejects transposition", () => {
    const base = computeAwardHash("aaa", "bbb", "ccc");
    expect(computeAwardHash("aaa2", "bbb", "ccc")).not.toBe(base);
    expect(computeAwardHash("aaa", "bbb2", "ccc")).not.toBe(base);
    expect(computeAwardHash("aaa", "bbb", "ccc2")).not.toBe(base);
    // (a,b) must not collide with (b,a).
    expect(computeAwardHash("bbb", "aaa", "ccc")).not.toBe(base);
  });
});
