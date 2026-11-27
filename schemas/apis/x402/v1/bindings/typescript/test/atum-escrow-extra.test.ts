/**
 * Conformance test for the AtumEscrowExtra JSON Schema — the drift-prevention
 * anchor for the `extra.atum` object. It asserts the canonical example validates
 * against the schema and that an object missing a required field is rejected.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

const v1 = (file: string): string =>
  fileURLToPath(new URL(`../../../extra/${file}`, import.meta.url));

const schema = JSON.parse(readFileSync(v1("schema.json"), "utf8")) as object;
const example = JSON.parse(readFileSync(v1("example.json"), "utf8")) as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

// Valid base58 (Solana) addresses, taken from the svm encoding golden vectors.
const B58_A = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const B58_B = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";
const B58_C = "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq";
const B58_D = "LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY";

describe("AtumEscrowExtra JSON Schema", () => {
  it("accepts the canonical example", () => {
    expect(validate(example)).toBe(true);
  });

  it("rejects an object missing the required destination", () => {
    const { destination, ...bad } = example;
    expect(validate(bad)).toBe(false);
  });

  // Multichain: the scheme is any-source → any-destination, so address fields accept
  // EVM hex OR base58, and a Solana source carries its signature-domain fields.
  it("accepts a Solana-source shape (base58 source roles + svm signature-domain fields)", () => {
    const sol = structuredClone(example) as typeof example;
    sol.escrow = B58_A;
    sol.reserver = B58_B;
    sol.releaser = B58_C;
    sol.svmSignatureClusterId = "localnet";
    sol.svmSignatureDomainVersion = 1;
    expect(validate(sol)).toBe(true);
  });

  // The block is closed, and the deposit's issue time is deliberately not one of its fields: it
  // comes from a clock, so a resource server rebuilding the block could not reproduce it, and the
  // payer stamps it into the signed authorization instead. Rejecting it here is what stops a
  // merchant reintroducing it.
  it("rejects an svm-domain shape that dictates an issue time", () => {
    const sol = structuredClone(example) as typeof example;
    sol.svmSignatureClusterId = "localnet";
    sol.svmSignatureDomainVersion = 1;
    (sol as Record<string, unknown>).issuedAt = "1700000000";
    expect(validate(sol)).toBe(false);
  });

  it("accepts a Solana-destination shape (base58 destination + fulfillment proxy)", () => {
    const sol = structuredClone(example) as typeof example;
    (sol as any).destination.network = "solana:localnet";
    (sol as any).destination.asset = B58_B;
    (sol as any).destination.address = B58_A;
    sol.fulfillmentProxy = B58_D;
    expect(validate(sol)).toBe(true);
  });

  it("rejects a source role that is neither EVM hex nor base58", () => {
    const bad = structuredClone(example) as typeof example;
    bad.escrow = "not_a_valid_address";
    expect(validate(bad)).toBe(false);
  });
});
