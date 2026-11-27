// The *-text fixtures are the textProof variants of the ed25519 quote, VP and
// PRE VP fixtures: same document, proof over ed25519ProofMessage(signingInput).
// Mirror of conformance_text_test.go.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { verifyQuote } from "./verify.js";
import { computeQuoteHash } from "./quote-hash.js";
import { verifyVP, type VerifyVPOptions } from "./verify-vp.js";

const fixturesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../conformance/fixtures"
);
const read = (name: string): string => readFileSync(resolve(fixturesDir, name), "utf-8");

const PRE_CONTEXT_URL =
  "https://schemas.atum.network/declarations/PaymentRequestEnvelope/v1/context.jsonld";
const PRE_CONTEXT = JSON.parse(
  read("../../../../PaymentRequestEnvelope/v1/context.jsonld")
) as Record<string, unknown>;
const HOLDER = "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS";
const ZERO_SEED_PUBKEY_HEX = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";

const vpOpts: VerifyVPOptions = {
  expectedChallenge: "req-fixture-1",
  expectedDomain: "did:web:settler.atum.network",
  expectedHolder: HOLDER,
  now: new Date("2026-04-01T00:00:30Z"),
  maxProofAgeMs: 60 * 60 * 1000,
  maxFutureSkewMs: 60 * 60 * 1000,
};
const preOpts: VerifyVPOptions = {
  ...vpOpts,
  expectedDeclarationType: "PaymentRequestEnvelope",
  envelopeContextUrl: PRE_CONTEXT_URL,
  extraEnvelopeContexts: { [PRE_CONTEXT_URL]: PRE_CONTEXT },
};

const proofValue = (doc: string): string =>
  (JSON.parse(doc) as { proof: { proofValue: string } }).proof.proofValue;

describe("conformance: ed25519 text fixtures", () => {
  for (const kind of ["signed", "vp", "pre-vp"] as const) {
    it(`${kind}: byte-identical across languages, raw fixture but for proofValue, verifies`, async () => {
      const goText = read(`ed25519-go-${kind}-text.json`);
      const text = read(`ed25519-ts-${kind}-text.json`);
      expect(goText).toBe(text);
      const raw = read(`ed25519-go-${kind}.json`);
      expect(proofValue(text)).not.toBe(proofValue(raw));
      expect(text.replace(proofValue(text), proofValue(raw))).toBe(raw);

      let pub: Uint8Array | null;
      if (kind === "signed") {
        pub = (await verifyQuote(text)).ed25519PublicKey;
        expect(await computeQuoteHash(text)).toBe(await computeQuoteHash(raw));
      } else {
        pub = (await verifyVP(text, kind === "vp" ? vpOpts : preOpts)).ed25519PublicKey;
      }
      expect(Buffer.from(pub!).toString("hex")).toBe(ZERO_SEED_PUBKEY_HEX);
    });
  }
});
