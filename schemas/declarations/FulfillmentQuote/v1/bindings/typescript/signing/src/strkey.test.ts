import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { decodeStellarAccount, encodeStellarAccount } from "./strkey.js";

// The one strkey vector file every Stellar strkey decoder in the repo is tested against. This module no
// longer carries its own decoder; the test proves that calling the shared one keeps every case's outcome,
// with the signer's extra rule that only a G account can sign.
interface StrkeyVectors {
  valid: { name: string; address: string; kind: "account" | "contract"; payloadHex: string }[];
  invalid: { name: string; address: string }[];
}

const vectors: StrkeyVectors = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      ...Array(8).fill(".."),
      "contracts",
      "stellar",
      "conformance",
      "strkey-vectors.json",
    ),
    "utf8",
  ),
);

const ACCOUNT_G = "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH";

describe("stellar strkey: shared vectors", () => {
  it("has cases to run", () => {
    expect(vectors.valid.length).toBeGreaterThan(0);
    expect(vectors.invalid.length).toBeGreaterThan(0);
  });

  it.each(vectors.valid.map((c) => [c.name, c] as const))("handles valid %s", (_name, c) => {
    if (c.kind === "contract") {
      // A C contract cannot sign, so the signer refuses what the decoder accepts.
      expect(() => decodeStellarAccount(c.address)).toThrow(/G account/);
      return;
    }
    const key = decodeStellarAccount(c.address);
    expect(Buffer.from(key).toString("hex")).toBe(c.payloadHex);
    expect(encodeStellarAccount(key)).toBe(c.address);
  });

  it.each(vectors.invalid.map((c) => [c.name, c] as const))("refuses %s", (_name, c) => {
    expect(() => decodeStellarAccount(c.address)).toThrow();
  });
});

describe("stellar strkey: refusal causes", () => {
  it.each([
    ["checksum", `${ACCOUNT_G.slice(0, 55)}G`, /checksum/],
    ["lowercase", ACCOUNT_G.toLowerCase(), /upper-case/],
    ["S-prefixed string, valid checksum", "SA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCTOLY", /not an account/],
    ["newline in a 31-byte payload", "GA5WUJ54Z23KILLCUOUN\nAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ", /upper-case/],
  ])("refuses a %s for the right cause", (_name, strkey, message) => {
    expect(() => decodeStellarAccount(strkey)).toThrow(message);
  });

  it("renders a key that is not 32 bytes as the empty string", () => {
    expect(encodeStellarAccount(new Uint8Array(31))).toBe("");
  });
});
