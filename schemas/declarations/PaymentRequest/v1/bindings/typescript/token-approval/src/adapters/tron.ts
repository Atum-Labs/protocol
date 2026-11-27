import { resolveTronPermit2 } from "@atum-labs/payment-request-sender-auth";
import type { ApprovalParams, TronTokenContract, TronWebLike } from "../types.js";
import type { TokenApprovalAdapter } from "./types.js";
import { isUnconfirmed, unconfirmed } from "./unconfirmed.js";

/**
 * The TRC-20 surface used to read and set the escrow-deposit allowance.
 *
 * Declared here rather than fetched from the chain. TronWeb's `contract().at(address)` builds
 * its interface from whatever ABI the node reports for that address, which makes the call fail
 * confusingly for any token whose published ABI is not what we expect, and costs a network round
 * trip every time. Passing the fragment is synchronous, needs no node, and keeps both chains
 * agreeing on the same two functions.
 */
export const TRC20_ALLOWANCE_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "View",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "Nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
];

const DEFAULT_FEE_LIMIT = 100_000_000;
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;

function requireTronWeb(params: ApprovalParams): TronWebLike {
  if (!params.tronWeb) {
    throw new Error(
      `token_approval: approving on ${params.network} needs a TronWeb instance configured ` +
        `for that chain (params.tronWeb)`,
    );
  }
  return params.tronWeb;
}

function token(params: ApprovalParams): TronTokenContract {
  // Safe because we passed the fragment on the line above: the handle has exactly these two
  // methods, whatever the chain would have reported for this address.
  return requireTronWeb(params).contract(TRC20_ALLOWANCE_ABI, params.token) as TronTokenContract;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the broadcast approval is on-chain.
 *
 * TronWeb's `send()` resolves as soon as the node accepts the transaction, not when it
 * executes, and `getTransactionInfo` returns an empty object until then. Returning on
 * broadcast would let a caller submit a deposit against an allowance that is not yet set.
 */
async function waitForConfirmation(
  tronWeb: TronWebLike,
  txId: string,
  options: ApprovalParams["confirmation"],
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let result: string | undefined;
    try {
      result = (await tronWeb.trx.getTransactionInfo(txId))?.receipt?.result;
    } catch {
      // A read failure is not a transaction failure — the approval is already broadcast, and
      // dropped connections and rate limits are routine on public Tron nodes. Rejecting here
      // would report a probably-fine approval as failed and lose its hash. Keep polling to the
      // deadline instead, and let the timeout say what is actually known.
    }
    if (result === "SUCCESS") return;
    if (result !== undefined) {
      throw new Error(`token_approval: Tron approval ${txId} failed on-chain (${result})`);
    }
    if (Date.now() >= deadline) {
      // Tagged, not just worded: a caller — and `approve` below — has to be able to tell "we
      // stopped watching" from "the chain rejected it", because the two deserve opposite advice.
      throw unconfirmed(
        `token_approval: Tron approval ${txId} was not confirmed within ${timeoutMs}ms. ` +
          `It may still confirm — check the transaction before approving again.`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

/** Broadcast one approval and wait for it, reporting the hash before the wait begins. */
async function send(
  params: ApprovalParams,
  contract: TronTokenContract,
  spender: string,
  amount: bigint,
  purpose: "approval" | "reset",
): Promise<string> {
  const txId = await contract
    .approve(spender, amount.toString())
    .send({ feeLimit: params.confirmation?.feeLimit ?? DEFAULT_FEE_LIMIT });
  params.onSubmitted?.(txId, purpose);
  await waitForConfirmation(requireTronWeb(params), txId, params.confirmation);
  return txId;
}

export const tronAdapter: TokenApprovalAdapter = {
  applicable: true,

  resolveSpender(params) {
    // Unlike the EVM deployment, Tron's Permit2 address differs per network, so it is looked
    // up rather than constant. The map is the one the sender-auth SDK signs against, which is
    // what makes a resolved address safe to approve.
    return params.spender ?? resolveTronPermit2(params.network);
  },

  async senderAddress(params) {
    // TronWeb signs as its default address, and `setAddress` drops a private key that does not
    // derive the address it is given — so this is the only account an approval can come from.
    // `false` is TronWeb's "unset", which means the instance cannot say, not that it is wrong.
    return requireTronWeb(params).defaultAddress?.base58 || undefined;
  },

  async readAllowance(params, spender) {
    const raw = await token(params).allowance(params.owner, spender).call();
    // TronWeb hands back a BigNumber-like, not a bigint.
    return BigInt(String(raw));
  },

  async approve(params, spender, amount, current) {
    const contract = token(params);

    // No reset-to-zero dance here, unlike EVM. Measured against a local Tron node rather than
    // assumed by symmetry:
    //
    //   - TronWeb refuses a constant call on a nonpayable method outright ("Methods with state
    //     mutability nonpayable must use send()"), so a probe could never report anything but
    //     "refused" and every approval over a non-zero allowance would reset first.
    //   - An ordinary TRC-20 accepts a non-zero to non-zero change (100 -> 500 directly), so
    //     there is nothing to work around on the tokens we can actually test.
    //   - Tron's USDT is a separate contract from the Ethereum one, not a redeploy, so the
    //     Ethereum restriction cannot be assumed to apply.
    //
    // Guessing would cost the payer a whole extra transaction at Tron's 100 TRX fee limit,
    // burned as energy, on every approval. If a Tron token ever does refuse, the error says so
    // and names the manual remedy rather than spending their money on a hunch.
    try {
      return { txHash: await send(params, contract, spender, amount, "approval") };
    } catch (error) {
      // Only a genuine on-chain failure earns the "approve 0 first" advice. A transaction we
      // merely stopped waiting for has very likely landed, and telling that payer to approve 0
      // would wipe the allowance their approval just set — the one destructive thing this
      // adapter could say, on the one path where it knows least.
      if (current === 0n || isUnconfirmed(error)) throw error;
      throw new Error(
        `token_approval: the approval on ${params.network} failed while an allowance of ` +
          `${current} was already set (${error instanceof Error ? error.message : String(error)}). ` +
          `Some tokens refuse to replace a non-zero allowance in place: approve 0 first, then ` +
          `retry.`,
      );
    }
  },
};
