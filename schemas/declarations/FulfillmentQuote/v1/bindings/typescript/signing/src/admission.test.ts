import { describe, it, expect } from "vitest";

import { AdmissionError } from "@atum-labs/ld-data-integrity";

import { canonicalize, FULFILLMENT_QUOTE_CONTEXT_URL } from "./canonicalize.js";

// Two identical destination objects become two blank nodes with the same
// first-degree quads, which RDFC-1.0 can only order by exploring
// permutations. The shared library refuses such a document as a whole, and
// this package's canonicalize must surface that refusal unchanged, so a
// caller can dispatch on the library's own error class. The entries carry
// no "id": with one they would be the same IRI node, not two blank nodes.
function quote(destination: Array<Record<string, string>>): Record<string, unknown> {
  return {
    "@context": [FULFILLMENT_QUOTE_CONTEXT_URL],
    version: "1.0",
    source_amount: "1000000",
    award_deadline: "2030-01-01T00:00:00Z",
    source: {
      id: "eip155:1/erc20:0xaaa",
      account: "eip155:1:0x1",
    },
    destination,
    settler_address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    payment_request_json: '{"request_id":"req-1"}',
  };
}

describe("canonicalize: dataset admission", () => {
  it("rejects two identical destination entries with the library's AdmissionError", async () => {
    const outcome = await canonicalize(
      quote([{ account: "eip155:1:0x2" }, { account: "eip155:1:0x2" }])
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    expect(outcome.ok).toBe(false);
    const error = outcome.ok ? undefined : outcome.error;
    expect(error).toBeInstanceOf(AdmissionError);
    expect((error as AdmissionError).rule).toBe("indistinguishable-blank-nodes");
    expect((error as AdmissionError).path).toBe("");
  });

  it("canonicalizes the same quote once its destination entries are distinct", async () => {
    const nquads = await canonicalize(
      quote([{ account: "eip155:1:0x2" }, { account: "eip155:1:0x3" }])
    );
    expect(nquads).toContain("eip155:1:0x2");
    expect(nquads).toContain("eip155:1:0x3");
  });
});
