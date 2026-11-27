import { describe, it, expect, beforeEach, vi } from "vitest";
import { Interface, MaxUint256 } from "ethers";
import { PERMIT2_CONTRACT_ADDRESS } from "@atum-labs/evm-escrow-encoding";

// Mock only ethers.Contract, so the allowance read and the approve tx are controllable while
// MaxUint256, Interface and everything else stay real. Scoped to this file.
const { allowanceMock, approveMock, callMock } = vi.hoisted(() => ({
  allowanceMock: vi.fn(),
  approveMock: vi.fn(),
  // The signer's raw `call`, which is how the adapter probes. Mocking this rather than
  // `staticCall` is the point: the probe must not decode, so the test must not decode either.
  callMock: vi.fn(),
}));

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  return {
    ...actual,
    // A regular function, not an arrow: the code under test calls `new Contract(...)`,
    // and vitest 4 only lets a mock be constructed when its implementation can be.
    Contract: vi.fn().mockImplementation(function () {
      return {
        allowance: allowanceMock,
        approve: approveMock,
        interface: new actual.Interface([
          "function approve(address spender, uint256 amount) returns (bool)",
        ]),
      };
    }),
  };
});

import { ensureSourceApproval, isUnconfirmed, needsSourceApproval } from "./index.js";
import { ERC20_ALLOWANCE_ABI } from "./adapters/evm.js";
import type { TronTokenContract, TronWebLike } from "./types.js";

const EVM = "eip155:8453";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** A minimal ethers signer: the raw `call` the probe uses, a nonce, and an account. */
function fakeSigner(address = "0xOwner"): never {
  return { call: callMock, getNonce: async () => 7, getAddress: async () => address } as never;
}
const signer = fakeSigner();
const evmBase = { network: EVM, token: "0xToken", owner: "0xOwner", signer };

/** A TronWeb stand-in. Injection is the whole point: no module mocking, no tronweb installed. */
function fakeTronWeb(overrides: {
  allowance?: bigint;
  txId?: string;
  /** `false` is TronWeb's own "no account set". */
  sender?: string | false;
}): {
  tronWeb: TronWebLike;
  approve: ReturnType<typeof vi.fn>;
} {
  const approve = vi.fn(() => ({
    call: async () => true,
    send: async () => overrides.txId ?? "tronTx",
  }));
  const contract: TronTokenContract = {
    allowance: () => ({
      call: async () => overrides.allowance ?? 0n,
      send: async () => "unused",
    }),
    approve: approve as unknown as TronTokenContract["approve"],
  };
  return {
    approve,
    tronWeb: {
      contract: () => contract,
      trx: { getTransactionInfo: async () => ({ receipt: { result: "SUCCESS" } }) },
      defaultAddress: { base58: overrides.sender === undefined ? "TOwner" : overrides.sender },
    },
  };
}

beforeEach(() => {
  allowanceMock.mockReset();
  approveMock.mockReset();
  callMock.mockReset();
  // An ordinary token accepts a straight approve, so the raw probe returns normally.
  callMock.mockResolvedValue("0x0000000000000000000000000000000000000000000000000000000000000001");
  approveMock.mockResolvedValue({ hash: "0xapprovetx", wait: async () => undefined });
});

describe("the ERC-20 fragment", () => {
  // Pins our hand-written fragment to the real ERC-20 interface. A typo in a parameter type or
  // order would change the selector, and the mocked Contract in these tests would never notice.
  it("encodes the two canonical ERC-20 selectors", () => {
    const iface = new Interface(ERC20_ALLOWANCE_ABI);
    expect(iface.getFunction("allowance")?.selector).toBe("0xdd62ed3e");
    expect(iface.getFunction("approve")?.selector).toBe("0x095ea7b3");
  });
});

describe("ensureSourceApproval on EVM", () => {
  it("skips the approval when the allowance already covers this charge", async () => {
    allowanceMock.mockResolvedValue(200n);
    const r = await ensureSourceApproval({ ...evmBase, requiredAllowance: 100n });
    expect(r).toEqual({ alreadySufficient: true });
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("approves when a stale smaller allowance does not cover this charge", async () => {
    allowanceMock.mockResolvedValue(1n);
    const r = await ensureSourceApproval({ ...evmBase, requiredAllowance: 100n });
    expect(r).toEqual({ alreadySufficient: false, txHash: "0xapprovetx" });
    expect(approveMock).toHaveBeenCalledWith(PERMIT2_CONTRACT_ADDRESS, MaxUint256);
  });

  it("treats an unlimited allowance decremented by earlier payments as sufficient", async () => {
    allowanceMock.mockResolvedValue(MaxUint256 - 10_000_000n);
    expect(await ensureSourceApproval(evmBase)).toEqual({ alreadySufficient: true });
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("defaults the spender to the canonical Permit2 and reads against it", async () => {
    allowanceMock.mockResolvedValue(MaxUint256);
    await ensureSourceApproval(evmBase);
    expect(allowanceMock).toHaveBeenCalledWith("0xOwner", PERMIT2_CONTRACT_ADDRESS);
  });

  it("uses the caller's spender when one is given", async () => {
    allowanceMock.mockResolvedValue(0n);
    await ensureSourceApproval({ ...evmBase, spender: "0xOther" });
    expect(allowanceMock).toHaveBeenCalledWith("0xOwner", "0xOther");
    expect(approveMock).toHaveBeenCalledWith("0xOther", MaxUint256);
  });

  it("names the missing signer rather than failing inside ethers", async () => {
    await expect(
      ensureSourceApproval({ network: EVM, token: "0xToken", owner: "0xOwner" }),
    ).rejects.toThrow(/needs an ethers signer/);
  });
});

describe("bounded approvals", () => {
  it("approves a bounded amount when the caller asks for one", async () => {
    allowanceMock.mockResolvedValue(0n);
    const r = await ensureSourceApproval({ ...evmBase, approvalAmount: 5_000n });
    expect(r.alreadySufficient).toBe(false);
    expect(approveMock).toHaveBeenCalledWith(PERMIT2_CONTRACT_ADDRESS, 5_000n);
  });

  // The defect this package exists to fix, reachable through the bounded option: a bounded
  // approval is never "unlimited", so without treating the amount as its own requirement every
  // later call would judge it insufficient and send another approval, forever.
  it("treats the amount it just granted as sufficient on the next call", async () => {
    allowanceMock.mockResolvedValue(5_000n);
    const r = await ensureSourceApproval({ ...evmBase, approvalAmount: 5_000n });
    expect(r).toEqual({ alreadySufficient: true });
    expect(approveMock).not.toHaveBeenCalled();
  });

  // Passed alone, the bound is measured against itself, so a payment that spends from it makes
  // it insufficient and the next call approves again. That is the only answer available when
  // nothing says what the next charge needs — and it is why repeated payments should pair the
  // bound with requiredAllowance, as the two tests here show side by side.
  it("re-approves a bound used alone once a payment has spent from it", async () => {
    allowanceMock.mockResolvedValue(4_999n);
    const r = await ensureSourceApproval({ ...evmBase, approvalAmount: 5_000n });
    expect(r.alreadySufficient).toBe(false);
    expect(approveMock).toHaveBeenCalledWith(PERMIT2_CONTRACT_ADDRESS, 5_000n);
  });

  it("leaves a partly spent bound alone when requiredAllowance covers the next charge", async () => {
    allowanceMock.mockResolvedValue(4_999n);
    const r = await ensureSourceApproval({
      ...evmBase,
      approvalAmount: 5_000n,
      requiredAllowance: 100n,
    });
    expect(r).toEqual({ alreadySufficient: true });
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("still approves when the granted bound no longer covers a larger charge", async () => {
    allowanceMock.mockResolvedValue(5_000n);
    const r = await ensureSourceApproval({
      ...evmBase,
      approvalAmount: 9_000n,
      requiredAllowance: 9_000n,
    });
    expect(r.alreadySufficient).toBe(false);
    expect(approveMock).toHaveBeenCalledWith(PERMIT2_CONTRACT_ADDRESS, 9_000n);
  });

  it("rejects a bounded amount below this charge before touching the chain", async () => {
    await expect(
      ensureSourceApproval({ ...evmBase, requiredAllowance: 100n, approvalAmount: 99n }),
    ).rejects.toThrow(/below requiredAllowance/);
    expect(allowanceMock).not.toHaveBeenCalled();
  });
});

describe("tokens that refuse to overwrite a non-zero allowance", () => {
  const revert = () => Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });

  it("resets to zero first when the token refuses the overwrite", async () => {
    allowanceMock.mockResolvedValue(100n);
    callMock.mockRejectedValue(revert());

    const r = await ensureSourceApproval(evmBase);

    expect(r.alreadySufficient).toBe(false);
    expect(r.resetTxHash).toBe("0xapprovetx");
    expect(approveMock).toHaveBeenCalledTimes(2);
    expect(approveMock).toHaveBeenNthCalledWith(1, PERMIT2_CONTRACT_ADDRESS, 0n, { nonce: 7 });
    expect(approveMock).toHaveBeenNthCalledWith(2, PERMIT2_CONTRACT_ADDRESS, MaxUint256, {
      nonce: 8,
    });
  });

  // The defect the first attempt at this shipped with. USDT's approve returns NOTHING, so a
  // decoding probe (staticCall against a `returns (bool)` fragment) throws BAD_DATA on every
  // call — and USDT, the one token this exists for, would have paid for two transactions every
  // single time. The probe must not decode.
  it("sends one transaction to a token whose approve returns no value", async () => {
    allowanceMock.mockResolvedValue(100n);
    callMock.mockResolvedValue("0x"); // USDT: empty return data, and no revert
    const r = await ensureSourceApproval(evmBase);
    expect(r.resetTxHash).toBeUndefined();
    expect(approveMock).toHaveBeenCalledTimes(1);
    expect(approveMock).toHaveBeenCalledWith(PERMIT2_CONTRACT_ADDRESS, MaxUint256);
  });

  // Answering an RPC blip by zeroing a working allowance, then possibly failing to restore it,
  // would leave the payer worse off than not calling at all.
  it("propagates an RPC failure instead of zeroing the allowance", async () => {
    allowanceMock.mockResolvedValue(100n);
    callMock.mockRejectedValue(Object.assign(new Error("connection reset"), { code: "NETWORK_ERROR" }));
    await expect(ensureSourceApproval(evmBase)).rejects.toThrow(/connection reset/);
    expect(approveMock).not.toHaveBeenCalled();
  });

  // A timeout on the replacement is not a failure: it may confirm a moment later and set the
  // real amount. Asserting "the allowance is currently 0" there is a false statement about the
  // payer's wallet, and a caller acting on it sends a second approval on top of one already on
  // its way.
  it("does not claim the allowance is 0 when the replacement is merely unconfirmed", async () => {
    allowanceMock.mockResolvedValue(100n);
    callMock.mockRejectedValue(revert());
    approveMock
      .mockResolvedValueOnce({ hash: "0xreset", wait: async () => undefined })
      .mockResolvedValueOnce({
        hash: "0xreplacement",
        wait: async () => {
          throw Object.assign(new Error("timeout exceeded"), { code: "TIMEOUT" });
        },
      });

    const error = await ensureSourceApproval(evmBase)
      .then(() => null)
      .catch((e: Error) => e);

    expect(error?.message).toMatch(/reset to 0 in 0xreset/);
    expect(error?.message).toMatch(/broadcast but not confirmed/);
    expect(error?.message).not.toMatch(/currently 0 — re-run/);
    // Asserted through the exported predicate, which is the only handle a caller has on the
    // distinction — reading the tag directly would test something consumers cannot use.
    expect(isUnconfirmed(error)).toBe(true);
  });

  it("says so plainly when the reset lands but the replacement does not", async () => {
    allowanceMock.mockResolvedValue(100n);
    callMock.mockRejectedValue(revert());
    approveMock
      .mockResolvedValueOnce({ hash: "0xreset", wait: async () => undefined })
      .mockRejectedValueOnce(new Error("dropped"));
    const error = await ensureSourceApproval(evmBase)
      .then(() => null)
      .catch((e: Error) => e);
    expect(error?.message).toMatch(
      /allowance was reset to 0 in 0xreset.*currently 0 — re-run to finish/s,
    );
    // Not unconfirmed: this one IS a failure, and a caller that waits for it to resolve itself
    // would wait forever on a zeroed allowance.
    expect(isUnconfirmed(error)).toBe(false);
  });

  it("never probes a fresh wallet, which has nothing to overwrite", async () => {
    allowanceMock.mockResolvedValue(0n);
    await ensureSourceApproval(evmBase);
    expect(callMock).not.toHaveBeenCalled();
    expect(approveMock).toHaveBeenCalledTimes(1);
  });

  it("sends a single approval on an ordinary token holding a partial allowance", async () => {
    allowanceMock.mockResolvedValue(100n);
    await ensureSourceApproval(evmBase);
    expect(approveMock).toHaveBeenCalledTimes(1);
    expect(approveMock).toHaveBeenCalledWith(PERMIT2_CONTRACT_ADDRESS, MaxUint256);
  });

  // Left to ethers, the replacement re-reads the nonce and a cached or fast-mining node hands
  // back the one the reset just used: "nonce too low", and the allowance stays at zero. Seen on
  // a local node before the nonces were fixed up front.
  it("pins sequential nonces so the replacement cannot reuse the reset's", async () => {
    allowanceMock.mockResolvedValue(100n);
    callMock.mockRejectedValue(revert());
    await ensureSourceApproval(evmBase);
    expect(approveMock).toHaveBeenNthCalledWith(1, PERMIT2_CONTRACT_ADDRESS, 0n, { nonce: 7 });
    expect(approveMock).toHaveBeenNthCalledWith(2, PERMIT2_CONTRACT_ADDRESS, MaxUint256, {
      nonce: 8,
    });
  });

  it("distinguishes the reset from the approval in onSubmitted", async () => {
    allowanceMock.mockResolvedValue(100n);
    callMock.mockRejectedValue(revert());
    const seen: string[] = [];
    await ensureSourceApproval({
      ...evmBase,
      onSubmitted: (hash, purpose) => seen.push(`${purpose}:${hash}`),
    });
    expect(seen).toEqual(["reset:0xapprovetx", "approval:0xapprovetx"]);
  });
});

// An approval only ever applies to the account that sends it, so a client for some other
// account approves THAT account, returns a hash that reads as success, and leaves the owner
// unable to pay. Caught before anything is broadcast.
describe("the account the approval is sent from", () => {
  it("refuses an EVM signer that does not hold the owner account", async () => {
    allowanceMock.mockResolvedValue(0n);
    await expect(
      ensureSourceApproval({ ...evmBase, signer: fakeSigner("0xSomeoneElse") }),
    ).rejects.toThrow(/would be sent by 0xSomeoneElse.*granted for 0xOwner/s);
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("accepts the same account written with different checksum casing", async () => {
    allowanceMock.mockResolvedValue(0n);
    const r = await ensureSourceApproval({
      ...evmBase,
      owner: "0xAbCdEf",
      signer: fakeSigner("0xabcdef"),
    });
    expect(r.alreadySufficient).toBe(false);
    expect(approveMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a TronWeb instance signing as another account", async () => {
    const { tronWeb, approve } = fakeTronWeb({ allowance: 0n, sender: "TSomeoneElse" });
    await expect(
      ensureSourceApproval({ network: "tron:mainnet", token: "TToken", owner: "TOwner", tronWeb }),
    ).rejects.toThrow(/would be sent by TSomeoneElse.*granted for TOwner/s);
    expect(approve).not.toHaveBeenCalled();
  });

  // A client that cannot say which account it would use is not a mismatch. Refusing here would
  // block clients that work, on no evidence.
  it("proceeds when the client cannot say which account it signs as", async () => {
    const { tronWeb, approve } = fakeTronWeb({ allowance: 0n, sender: false });
    const r = await ensureSourceApproval({
      network: "tron:mainnet",
      token: "TToken",
      owner: "TOwner",
      tronWeb,
    });
    expect(r.alreadySufficient).toBe(false);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  // Reading is not granting: asking whether a payer is ready, for a payer whose keys you do not
  // hold, is exactly what this is for.
  it("does not apply the check to the read-only preflight", async () => {
    allowanceMock.mockResolvedValue(0n);
    expect(
      await needsSourceApproval({ ...evmBase, signer: fakeSigner("0xSomeoneElse") }),
    ).toBe(true);
  });

  // Nothing is sent when the allowance already suffices, so there is nothing to get wrong.
  it("does not refuse an unrelated signer when no approval is needed", async () => {
    allowanceMock.mockResolvedValue(MaxUint256);
    const r = await ensureSourceApproval({ ...evmBase, signer: fakeSigner("0xSomeoneElse") });
    expect(r).toEqual({ alreadySufficient: true });
  });
});

describe("waiting for an EVM approval", () => {
  it("reports a reverted approval as a failure rather than a hash", async () => {
    allowanceMock.mockResolvedValue(0n);
    approveMock.mockResolvedValue({
      hash: "0xapprovetx",
      wait: async () => {
        throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
      },
    });
    await expect(ensureSourceApproval(evmBase)).rejects.toThrow(/execution reverted/);
  });

  it("says an unconfirmed approval may still land, instead of calling it failed", async () => {
    allowanceMock.mockResolvedValue(0n);
    approveMock.mockResolvedValue({
      hash: "0xapprovetx",
      wait: async () => {
        throw Object.assign(new Error("timeout exceeded"), { code: "TIMEOUT" });
      },
    });
    const error = await ensureSourceApproval(evmBase)
      .then(() => null)
      .catch((e: Error) => e);
    expect(error?.message).toMatch(/may still confirm/);
    expect(isUnconfirmed(error)).toBe(true);
  });

  // A stuck allowance reset and a stuck approval need different responses, and calling both
  // "the approval" sends the payer looking for the wrong transaction.
  it("names a stuck allowance reset as such, not as the approval", async () => {
    allowanceMock.mockResolvedValue(100n);
    callMock.mockRejectedValue(Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION" }));
    approveMock.mockResolvedValue({
      hash: "0xresettx",
      wait: async () => {
        throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
      },
    });
    await expect(ensureSourceApproval(evmBase)).rejects.toThrow(
      /allowance reset 0xresettx was not confirmed/,
    );
  });

  // A revert whose reason string happens to contain "timeout" must not be softened into
  // "it may still confirm" — that would tell a payer a failed approval might yet land.
  it("does not mistake a revert mentioning timeout for an unconfirmed transaction", async () => {
    allowanceMock.mockResolvedValue(0n);
    approveMock.mockResolvedValue({
      hash: "0xapprovetx",
      wait: async () => {
        throw Object.assign(new Error("execution reverted: deadline timeout"), {
          code: "CALL_EXCEPTION",
        });
      },
    });
    const error = await ensureSourceApproval(evmBase)
      .then(() => null)
      .catch((e: Error) => e);
    expect(error?.message).toMatch(/execution reverted/);
    expect(error?.message).not.toMatch(/may still confirm/);
    expect(isUnconfirmed(error)).toBe(false);
  });

  it("returns the hash only once the approval is mined, not when it is broadcast", async () => {
    allowanceMock.mockResolvedValue(0n);
    let mined = false;
    approveMock.mockResolvedValue({
      hash: "0xapprovetx",
      wait: async () => {
        mined = true;
      },
    });
    const r = await ensureSourceApproval(evmBase);
    expect(mined).toBe(true);
    expect(r.txHash).toBe("0xapprovetx");
  });

  it("hands the hash to onSubmitted before the wait, so a caller can follow it", async () => {
    allowanceMock.mockResolvedValue(0n);
    const seen: string[] = [];
    approveMock.mockResolvedValue({
      hash: "0xapprovetx",
      wait: async () => {
        seen.push("waited");
      },
    });
    await ensureSourceApproval({
      ...evmBase,
      onSubmitted: (hash) => seen.push(`submitted:${hash}`),
    });
    expect(seen).toEqual(["submitted:0xapprovetx", "waited"]);
  });

  it("honours a caller's confirmation timeout", async () => {
    allowanceMock.mockResolvedValue(0n);
    const wait = vi.fn(async () => undefined);
    approveMock.mockResolvedValue({ hash: "0xapprovetx", wait });
    await ensureSourceApproval({ ...evmBase, confirmation: { timeoutMs: 1_234 } });
    expect(wait).toHaveBeenCalledWith(1, 1_234);
  });
});

describe("ensureSourceApproval on Tron", () => {
  it("resolves the pinned Permit2 for the network and approves through TronWeb", async () => {
    const { tronWeb, approve } = fakeTronWeb({ allowance: 0n });
    const r = await ensureSourceApproval({
      network: "tron:mainnet",
      token: "TToken",
      owner: "TOwner",
      tronWeb,
    });
    expect(r).toEqual({ alreadySufficient: false, txHash: "tronTx" });
    expect(approve).toHaveBeenCalledWith(
      "TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m",
      MaxUint256.toString(),
    );
  });

  it("applies the same decrement-tolerant gate as EVM", async () => {
    const { tronWeb, approve } = fakeTronWeb({ allowance: MaxUint256 - 10_000_000n });
    const r = await ensureSourceApproval({
      network: "tron:shasta",
      token: "TToken",
      owner: "TOwner",
      tronWeb,
    });
    expect(r).toEqual({ alreadySufficient: true });
    expect(approve).not.toHaveBeenCalled();
  });

  it("names the missing TronWeb instance", async () => {
    await expect(
      ensureSourceApproval({ network: "tron:mainnet", token: "TToken", owner: "TOwner" }),
    ).rejects.toThrow(/needs a TronWeb instance/);
  });

  it("refuses a Tron network it has no pinned Permit2 for", async () => {
    const { tronWeb } = fakeTronWeb({});
    await expect(
      ensureSourceApproval({ network: "tron:nile", token: "TToken", owner: "TOwner", tronWeb }),
    ).rejects.toThrow(/no Permit2 address known/);
  });
});

describe("ensureSourceApproval on Solana", () => {
  it("reports sufficiency without touching the chain", async () => {
    const r = await ensureSourceApproval({ network: SOLANA, token: "mint", owner: "acct" });
    expect(r).toEqual({ alreadySufficient: true });
    expect(allowanceMock).not.toHaveBeenCalled();
    expect(approveMock).not.toHaveBeenCalled();
  });
});

describe("needsSourceApproval", () => {
  it("reports true when an approval would be sent, and sends nothing", async () => {
    allowanceMock.mockResolvedValue(0n);
    expect(await needsSourceApproval(evmBase)).toBe(true);
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("reports false when the allowance already suffices", async () => {
    allowanceMock.mockResolvedValue(MaxUint256);
    expect(await needsSourceApproval(evmBase)).toBe(false);
    expect(approveMock).not.toHaveBeenCalled();
  });

  // The two must not disagree about identical arguments, or a preflight would promise one thing
  // and the approval do another.
  it("answers a bounded approvalAmount the same way ensureSourceApproval does", async () => {
    allowanceMock.mockResolvedValue(5_000n);
    expect(await needsSourceApproval({ ...evmBase, approvalAmount: 5_000n })).toBe(false);
    expect(await ensureSourceApproval({ ...evmBase, approvalAmount: 5_000n })).toEqual({
      alreadySufficient: true,
    });
  });

  it("reports false on Solana, which has no allowance to grant", async () => {
    expect(await needsSourceApproval({ network: SOLANA, token: "mint", owner: "a" })).toBe(false);
  });

  it("answers for Tron too", async () => {
    const { tronWeb } = fakeTronWeb({ allowance: 0n });
    expect(
      await needsSourceApproval({
        network: "tron:mainnet",
        token: "TToken",
        owner: "TOwner",
        tronWeb,
      }),
    ).toBe(true);
  });
});
