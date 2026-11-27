import { describe, it, expect, vi } from "vitest";
import { Interface } from "ethers";
import { tronAdapter, TRC20_ALLOWANCE_ABI } from "./tron.js";
import { ERC20_ALLOWANCE_ABI } from "./evm.js";
import type { ApprovalParams, TronTokenContract, TronWebLike } from "../types.js";
import { isUnconfirmed } from "../index.js";

const base = { network: "tron:shasta", token: "TToken", owner: "TOwner" };

interface Fake {
  tronWeb: TronWebLike;
  send: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
  infoCalls: () => number;
  contractCalls: () => number;
}

/**
 * A TronWeb stand-in whose `getTransactionInfo` walks a scripted sequence, so the confirmation
 * poll can be driven without a chain. TronWeb returns `{}` until the transaction executes, and
 * an entry of `null` stands for a read that threw.
 */
function fakeTron(opts: {
  receipts?: Array<{ receipt?: { result?: string } } | null>;
  allowance?: bigint;
}): Fake {
  const receipts = opts.receipts ?? [{ receipt: { result: "SUCCESS" } }];
  const send = vi.fn(async () => "tronTx");
  const approve = vi.fn(() => ({ call: async () => true, send }));
  let infoCalls = 0;
  let contractCalls = 0;
  const contract: TronTokenContract = {
    allowance: () => ({ call: async () => opts.allowance ?? 0n, send: async () => "unused" }),
    approve: approve as unknown as TronTokenContract["approve"],
  };
  return {
    send,
    approve,
    infoCalls: () => infoCalls,
    contractCalls: () => contractCalls,
    tronWeb: {
      contract: () => {
        contractCalls += 1;
        return contract;
      },
      trx: {
        getTransactionInfo: async () => {
          const entry = receipts[Math.min(infoCalls++, receipts.length - 1)];
          if (entry === null) throw new Error("ECONNRESET");
          return entry;
        },
      },
    },
  };
}

const fast = (tronWeb: TronWebLike, extra: Partial<ApprovalParams> = {}): ApprovalParams => ({
  ...base,
  tronWeb,
  confirmation: { pollIntervalMs: 1, timeoutMs: 500 },
  ...extra,
});

describe("the TRC-20 fragment", () => {
  // Both chains must describe the same two functions. Deriving the selectors from the Tron
  // fragment and comparing them with the EVM one is what stops the two drifting apart.
  it("describes the same calls as the EVM fragment", () => {
    const evm = new Interface(ERC20_ALLOWANCE_ABI);
    const tron = new Interface(TRC20_ALLOWANCE_ABI as never);
    expect(tron.getFunction("allowance")?.selector).toBe(evm.getFunction("allowance")?.selector);
    expect(tron.getFunction("approve")?.selector).toBe(evm.getFunction("approve")?.selector);
  });
});

describe("tronAdapter.resolveSpender", () => {
  it("resolves the pinned Permit2 per network, which differs unlike the EVM deployment", () => {
    expect(tronAdapter.resolveSpender({ ...base, network: "tron:mainnet" })).toBe(
      "TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m",
    );
    expect(tronAdapter.resolveSpender({ ...base, network: "tron:shasta" })).toBe(
      "TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp",
    );
  });

  it("prefers an explicit spender over the pinned one", () => {
    expect(tronAdapter.resolveSpender({ ...base, spender: "TOther" })).toBe("TOther");
  });
});

describe("tronAdapter.readAllowance", () => {
  it("converts TronWeb's BigNumber-like reading into a bigint", async () => {
    const contract: TronTokenContract = {
      allowance: () => ({
        call: async () => ({ toString: () => "12345" }),
        send: async () => "unused",
      }),
      approve: () => ({ call: async () => true, send: async () => "unused" }),
    };
    const tronWeb: TronWebLike = {
      contract: () => contract,
      trx: { getTransactionInfo: async () => ({}) },
    };
    expect(await tronAdapter.readAllowance({ ...base, tronWeb }, "TSpender")).toBe(12345n);
  });

  // The ABI is passed in, so the handle is built locally. `contract().at(address)` would fetch
  // it from the node on every use.
  it("builds the contract handle without a network round trip", async () => {
    const f = fakeTron({ allowance: 1n });
    await tronAdapter.readAllowance({ ...base, tronWeb: f.tronWeb }, "TSpender");
    expect(f.contractCalls()).toBe(1);
  });
});

describe("tronAdapter.approve", () => {
  it("waits for the receipt instead of returning on broadcast", async () => {
    // TronWeb's send() resolves when the node accepts the tx, not when it executes. Returning
    // then would let a caller deposit against an allowance that is not set yet.
    const f = fakeTron({ receipts: [{}, {}, { receipt: { result: "SUCCESS" } }] });
    expect(await tronAdapter.approve(fast(f.tronWeb), "TSpender", 1n, 0n)).toEqual({
      txHash: "tronTx",
    });
    expect(f.infoCalls()).toBe(3);
  });

  it("surfaces an on-chain failure rather than reporting a successful approval", async () => {
    const f = fakeTron({ receipts: [{ receipt: { result: "REVERT" } }] });
    await expect(tronAdapter.approve(fast(f.tronWeb), "TSpender", 1n, 0n)).rejects.toThrow(
      /failed on-chain \(REVERT\)/,
    );
  });

  // A dropped connection or a rate limit from a public node says nothing about the approval,
  // which is already broadcast. Rejecting there would report a probably-fine approval as
  // failed and lose its hash.
  it("keeps polling through a failed read instead of giving up on the approval", async () => {
    const f = fakeTron({ receipts: [null, null, { receipt: { result: "SUCCESS" } }] });
    expect(await tronAdapter.approve(fast(f.tronWeb), "TSpender", 1n, 0n)).toEqual({
      txHash: "tronTx",
    });
    expect(f.infoCalls()).toBe(3);
  });

  it("gives up with a message that does not claim the approval failed", async () => {
    const f = fakeTron({ receipts: [{}] });
    await expect(
      tronAdapter.approve(
        { ...base, tronWeb: f.tronWeb, confirmation: { pollIntervalMs: 1, timeoutMs: 5 } },
        "TSpender",
        1n,
        0n,
      ),
    ).rejects.toThrow(/was not confirmed within 5ms/);
  });

  it("reports a read that never succeeds as unconfirmed, not as a failure", async () => {
    const f = fakeTron({ receipts: [null] });
    await expect(
      tronAdapter.approve(
        { ...base, tronWeb: f.tronWeb, confirmation: { pollIntervalMs: 1, timeoutMs: 5 } },
        "TSpender",
        1n,
        0n,
      ),
    ).rejects.toThrow(/may still confirm/);
  });

  it("sends the amount as a string with the default fee limit", async () => {
    const f = fakeTron({});
    await tronAdapter.approve(fast(f.tronWeb), "TSpender", 42n, 0n);
    expect(f.approve).toHaveBeenCalledWith("TSpender", "42");
    expect(f.send).toHaveBeenCalledWith({ feeLimit: 100_000_000 });
  });

  it("honours a caller's fee limit", async () => {
    const f = fakeTron({});
    await tronAdapter.approve(
      fast(f.tronWeb, { confirmation: { pollIntervalMs: 1, feeLimit: 7 } }),
      "TSpender",
      42n,
      0n,
    );
    expect(f.send).toHaveBeenCalledWith({ feeLimit: 7 });
  });

  it("hands the hash to onSubmitted before waiting for it", async () => {
    const seen: string[] = [];
    const f = fakeTron({ receipts: [{ receipt: { result: "SUCCESS" } }] });
    await tronAdapter.approve(
      fast(f.tronWeb, { onSubmitted: (h, purpose) => seen.push(`${purpose}:${h}`) }),
      "TSpender",
      1n,
      0n,
    );
    expect(seen).toEqual(["approval:tronTx"]);
  });

  // Measured on a local Tron node: TronWeb refuses a constant call on a nonpayable method, so a
  // probe could only ever report "refused"; and an ordinary TRC-20 accepts a non-zero to
  // non-zero change. A reset here would therefore burn an extra 100 TRX transaction every time,
  // for a restriction there is no evidence any Tron token has.
  it("never sends a reset, whatever the existing allowance", async () => {
    const f = fakeTron({});
    await tronAdapter.approve(fast(f.tronWeb), "TSpender", 42n, 100n);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.approve).toHaveBeenCalledTimes(1);
    expect(f.approve).toHaveBeenCalledWith("TSpender", "42");
  });

  it("names the manual remedy when an approval over a non-zero allowance fails", async () => {
    const f = fakeTron({});
    f.send.mockRejectedValueOnce(new Error("REVERT opcode executed"));
    await expect(tronAdapter.approve(fast(f.tronWeb), "TSpender", 42n, 100n)).rejects.toThrow(
      /approve 0 first, then retry/,
    );
  });

  // The two cases have to cross: a timeout over a NON-ZERO allowance is the one place where the
  // "approve 0 first" advice would be destructive. The approval has very likely landed, so
  // following that advice would wipe the allowance it just set.
  it("never tells a payer to approve 0 when the approval merely went unconfirmed", async () => {
    const f = fakeTron({ receipts: [{}] });
    const error = await tronAdapter
      .approve(
        { ...base, tronWeb: f.tronWeb, confirmation: { pollIntervalMs: 1, timeoutMs: 5 } },
        "TSpender",
        42n,
        100n,
      )
      .then(() => null)
      .catch((e: Error) => e);

    expect(error?.message).toMatch(/may still confirm/);
    expect(error?.message).not.toMatch(/approve 0 first/);
    // Through the exported predicate: both chains have to answer a caller the same way.
    expect(isUnconfirmed(error)).toBe(true);
  });

  it("leaves a failure on a fresh wallet unwrapped, since no allowance can be in the way", async () => {
    const f = fakeTron({});
    f.send.mockRejectedValueOnce(new Error("REVERT opcode executed"));
    await expect(tronAdapter.approve(fast(f.tronWeb), "TSpender", 42n, 0n)).rejects.toThrow(
      /^REVERT opcode executed$/,
    );
  });
});
