import { describe, it, expect } from "vitest";
import { approvalAdapterFor } from "./index.js";
import { evmAdapter } from "./evm.js";
import { tronAdapter } from "./tron.js";
import { solanaAdapter } from "./solana.js";

describe("approvalAdapterFor", () => {
  it("selects by CAIP-2 namespace, not by the whole network id", () => {
    expect(approvalAdapterFor("eip155:8453")).toBe(evmAdapter);
    expect(approvalAdapterFor("eip155:1")).toBe(evmAdapter);
    expect(approvalAdapterFor("tron:mainnet")).toBe(tronAdapter);
    expect(approvalAdapterFor("tron:shasta")).toBe(tronAdapter);
    expect(approvalAdapterFor("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe(solanaAdapter);
  });

  it("reports Solana as having no allowance to manage", () => {
    expect(solanaAdapter.applicable).toBe(false);
    expect(evmAdapter.applicable).toBe(true);
    expect(tronAdapter.applicable).toBe(true);
  });

  it("rejects a namespace it has no adapter for", () => {
    expect(() => approvalAdapterFor("cosmos:hub")).toThrow(/no approval adapter/);
  });

  // A prototype member is truthy, so a plain `ADAPTERS[ns]` lookup would hand back
  // Object.prototype.constructor for these and treat an unsupported chain as supported.
  it.each(["constructor:1", "toString:1", "__proto__:1", "hasOwnProperty:1"])(
    "does not resolve the inherited name in %s",
    (network) => {
      expect(() => approvalAdapterFor(network)).toThrow(/no approval adapter/);
    },
  );
});
