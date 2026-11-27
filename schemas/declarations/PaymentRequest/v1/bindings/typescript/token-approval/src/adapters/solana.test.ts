import { describe, it, expect } from "vitest";
import { solanaAdapter } from "./solana.js";

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

describe("solanaAdapter", () => {
  it("is not applicable, so the allowance methods are never the caller's path", () => {
    expect(solanaAdapter.applicable).toBe(false);
  });

  // Reached only by a caller that ignored `applicable`. Throwing beats silently succeeding:
  // a no-op approval would report that a wallet is ready when nothing was checked.
  it("refuses a spender", () => {
    expect(() => solanaAdapter.resolveSpender({ network: SOLANA, token: "x", owner: "y" })).toThrow(
      /Permit2-style allowance/,
    );
  });

  it("refuses to name a sending account", async () => {
    await expect(
      solanaAdapter.senderAddress({ network: SOLANA, token: "x", owner: "y" }),
    ).rejects.toThrow(/Permit2-style allowance/);
  });

  it("refuses an allowance read", async () => {
    await expect(
      solanaAdapter.readAllowance({ network: SOLANA, token: "x", owner: "y" }, "s"),
    ).rejects.toThrow(/Permit2-style allowance/);
  });

  it("refuses an approval", async () => {
    await expect(
      solanaAdapter.approve({ network: SOLANA, token: "x", owner: "y" }, "s", 1n, 0n),
    ).rejects.toThrow(/Permit2-style allowance/);
  });
});
