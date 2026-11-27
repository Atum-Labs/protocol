/**
 * Conformance test for the AtumEscrowPayload JSON Schema — the drift-prevention
 * anchor for the PAYMENT-SIGNATURE credential body. It asserts the canonical
 * example (carrying the PaymentRequestEnvelope identity binding) validates; that a
 * payload without `presentation` still validates (the envelope is required by
 * facilitator policy, optional at the schema level); that a `presentation` whose
 * proof purpose is not `authentication` is rejected; that a canonical
 * `message_scheme` enum value is accepted while a value outside the enum is
 * rejected (the facilitator, not the schema, enforces which schemes it verifies);
 * and that a payload missing `paymentRequest` is rejected.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

const v1 = (file: string): string =>
  fileURLToPath(new URL(`../../../payload/${file}`, import.meta.url));

const schema = JSON.parse(readFileSync(v1("schema.json"), "utf8")) as object;
const example = JSON.parse(readFileSync(v1("example.json"), "utf8")) as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

// Valid base58 (Solana) addresses, taken from the svm encoding golden vectors.
const B58_ACCOUNT = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const B58_ASSET = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";
const B58_ESCROW = "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq";

describe("AtumEscrowPayload JSON Schema", () => {
  it("accepts the canonical example (with the PaymentRequestEnvelope binding)", () => {
    expect(validate(example)).toBe(true);
  });

  it("still accepts a payload without presentation (optional at the schema level)", () => {
    const noPre = structuredClone(example) as typeof example;
    delete (noPre as any).payload.paymentRequest.presentation;
    expect(validate(noPre)).toBe(true);
  });

  it("rejects a presentation whose proof.proofPurpose is not authentication", () => {
    const bad = structuredClone(example) as typeof example;
    (bad as any).payload.paymentRequest.presentation.proof.proofPurpose = "assertionMethod";
    expect(validate(bad)).toBe(false);
  });

  it("accepts a canonical sender_auth.message_scheme value other than EVM_PERMIT2", () => {
    const other = structuredClone(example) as typeof example;
    (other as any).payload.paymentRequest.sender_auth.message_scheme = "SOLANA";
    expect(validate(other)).toBe(true);
  });

  it("rejects a sender_auth.message_scheme outside the canonical enum", () => {
    const bad = structuredClone(example) as typeof example;
    (bad as any).payload.paymentRequest.sender_auth.message_scheme = "FOO";
    expect(validate(bad)).toBe(false);
  });

  it("rejects a payload missing paymentRequest", () => {
    const bad = structuredClone(example) as typeof example;
    delete (bad as any).payload.paymentRequest;
    expect(validate(bad)).toBe(false);
  });

  // Multichain: address fields accept EVM hex OR base58, for both a Solana source
  // (the payer deposits on Solana) and a Solana destination (the merchant receives there).
  it("accepts a Solana-source payload (base58 source.account, asset and payTo)", () => {
    const sol = structuredClone(example) as typeof example;
    (sol as any).accepted.network = "solana:localnet";
    (sol as any).accepted.asset = B58_ASSET;
    (sol as any).accepted.payTo = B58_ESCROW;
    (sol as any).payload.paymentRequest.source.account = B58_ACCOUNT;
    (sol as any).payload.paymentRequest.sender_auth.message_scheme = "SOLANA";
    expect(validate(sol)).toBe(true);
  });

  it("accepts a Solana-destination payload (base58 destination account)", () => {
    const sol = structuredClone(example) as typeof example;
    (sol as any).payload.paymentRequest.destination[0].account = B58_ACCOUNT;
    expect(validate(sol)).toBe(true);
  });

  it("rejects a source.account that is neither EVM hex nor base58", () => {
    const bad = structuredClone(example) as typeof example;
    (bad as any).payload.paymentRequest.source.account = "0xnothex";
    expect(validate(bad)).toBe(false);
  });
});
