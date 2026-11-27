import { describe, it, expect } from "vitest";

import { AdmissionError } from "@atum-labs/ld-data-integrity";

import { canonicalize, PAYMENT_REQUEST_CONTEXT_URL } from "./canonicalize.js";

// Two identical entries of an array of objects become two blank nodes with
// the same first-degree quads, which RDFC-1.0 can only order by exploring
// permutations. The shared library refuses such a document as a whole, and
// this package's canonicalize must surface that refusal unchanged, so a
// caller can dispatch on the library's own error class.
function request(destination: Array<Record<string, string>>): Record<string, unknown> {
  return {
    "@context": [PAYMENT_REQUEST_CONTEXT_URL],
    version: "1.0",
    request_id: "req-admission-1",
    source: {
      account: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      asset_identifier: "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A",
    },
    destination,
    fulfillment_amount: "1000000",
    quote_deadline: "2030-01-01T00:00:00Z",
    fulfillment_deadline: "2030-01-02T00:00:00Z",
  };
}

const ENTRY = {
  account: "0x0000000000000000000000000000000000000002",
  asset_identifier: "eip155:1/erc20:0xbbb",
};

describe("canonicalize: dataset admission", () => {
  it("rejects two identical destination entries with the library's AdmissionError", async () => {
    const outcome = await canonicalize(request([{ ...ENTRY }, { ...ENTRY }])).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    expect(outcome.ok).toBe(false);
    const error = outcome.ok ? undefined : outcome.error;
    expect(error).toBeInstanceOf(AdmissionError);
    expect((error as AdmissionError).rule).toBe("indistinguishable-blank-nodes");
    expect((error as AdmissionError).path).toBe("");
  });

  it("canonicalizes the same request once its destination entries are distinct", async () => {
    const nquads = await canonicalize(
      request([{ ...ENTRY }, { ...ENTRY, account: "0x0000000000000000000000000000000000000003" }])
    );
    expect(nquads).toContain("0x0000000000000000000000000000000000000002");
    expect(nquads).toContain("0x0000000000000000000000000000000000000003");
  });
});
