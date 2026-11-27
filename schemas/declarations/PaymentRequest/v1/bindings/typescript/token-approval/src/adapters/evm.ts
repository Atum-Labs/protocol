import { Contract, type ContractTransactionResponse, type Signer } from "ethers";
import { PERMIT2_CONTRACT_ADDRESS } from "@atum-labs/evm-escrow-encoding";
import type { ApprovalParams } from "../types.js";
import type { TokenApprovalAdapter } from "./types.js";
import { isUnconfirmed, unconfirmed } from "./unconfirmed.js";

/** The ERC-20 surface used to read and set the escrow-deposit allowance. */
export const ERC20_ALLOWANCE_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000;

function requireSigner(params: ApprovalParams): Signer {
  if (!params.signer) {
    throw new Error(
      `token_approval: approving on ${params.network} needs an ethers signer connected to ` +
        `that chain (params.signer)`,
    );
  }
  return params.signer;
}

function erc20(params: ApprovalParams): Contract {
  return new Contract(params.token, ERC20_ALLOWANCE_ABI, requireSigner(params));
}

/**
 * Broadcast an approval and wait for it to be mined, within a bounded time.
 *
 * The hash is handed to `onSubmitted` BEFORE the wait: the transaction is already spending the
 * caller's gas at that point, so they should be able to follow it even if the wait ends badly.
 *
 * A timeout is not a failure. The approval was broadcast and may still confirm, so it is
 * reported as unconfirmed and the caller is told to check it rather than send another.
 */
async function send(
  params: ApprovalParams,
  call: Promise<ContractTransactionResponse>,
  purpose: "approval" | "reset",
): Promise<string> {
  const tx = await call;
  params.onSubmitted?.(tx.hash, purpose);
  const timeoutMs = params.confirmation?.timeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
  try {
    await tx.wait(1, timeoutMs);
  } catch (error) {
    // ethers reports a timeout and an on-chain revert through the same call. A revert is a real
    // failure and must surface as one; only the timeout gets the softer wording.
    if (isTimeout(error)) {
      // Named by purpose: a stuck allowance reset and a stuck approval need different responses,
      // and calling both "the approval" sends the payer looking for the wrong transaction.
      throw unconfirmed(
        `token_approval: the ${purpose === "reset" ? "allowance reset" : "approval"} ` +
          `${tx.hash} was not confirmed within ${timeoutMs}ms. It may still confirm — check ` +
          `the transaction before approving again.`,
      );
    }
    throw error;
  }
  return tx.hash;
}

function isTimeout(error: unknown): boolean {
  // Exactly ethers' timeout code, with no message sniffing: a revert whose reason string happens
  // to contain "timeout" must not be softened into "it may still confirm".
  return (error as { code?: string } | null)?.code === "TIMEOUT";
}

export const evmAdapter: TokenApprovalAdapter = {
  applicable: true,

  resolveSpender(params) {
    return params.spender ?? PERMIT2_CONTRACT_ADDRESS;
  },

  async senderAddress(params) {
    return await requireSigner(params).getAddress();
  },

  async readAllowance(params, spender) {
    return (await erc20(params).allowance(params.owner, spender)) as bigint;
  },

  async approve(params, spender, amount, current) {
    const token = erc20(params);

    // A token can only refuse an in-place overwrite when there is something to overwrite, so a
    // fresh wallet — the overwhelming majority — never reaches the probe at all. `amount` needs
    // no such guard: resolveApprovalAmount is the only thing that produces it, and it refuses a
    // non-positive bound outright.
    if (current !== 0n && (await refusesOverwrite(params, token, spender, amount))) {
      // Both nonces are fixed up front. Left to ethers, the second transaction re-reads the
      // account's nonce, and a provider that answers from a short-lived cache — or a chain that
      // mines fast enough to stay inside it — hands back the one the reset just consumed, so the
      // replacement is rejected as "nonce too low" and the allowance is left at zero. Observed on
      // a local node. Two sequential sends from one account have deterministic nonces, so there
      // is nothing to look up.
      const nonce = await requireSigner(params).getNonce("pending");
      const resetTxHash = await send(params, token.approve(spender, 0n, { nonce }), "reset");
      try {
        return {
          txHash: await send(params, token.approve(spender, amount, { nonce: nonce + 1 }), "approval"),
          resetTxHash,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // A replacement we merely stopped waiting for is very likely to land, which would set
        // the allowance to `amount` rather than leave it at 0. Asserting "the allowance is
        // currently 0 — re-run" would then be false, and acting on it sends a second approval
        // on top of one already on its way. Keep the unconfirmed tag so the caller can still
        // tell an unknown from a failure.
        if (isUnconfirmed(error)) {
          throw unconfirmed(
            `token_approval: the allowance was reset to 0 in ${resetTxHash} and the new ` +
              `approval was broadcast but not confirmed (${detail}). If it lands the allowance ` +
              `is ${amount}; if it does not, it stays 0. Check that transaction before ` +
              `approving again.`,
          );
        }
        // The allowance is now 0 and the replacement definitively did not land. Saying so
        // plainly matters: the payer is worse off than before the call and would otherwise have
        // no idea why.
        throw new Error(
          `token_approval: the allowance was reset to 0 in ${resetTxHash}, but the new approval ` +
            `did not go through (${detail}). The allowance is currently 0 — re-run to finish.`,
        );
      }
    }

    return { txHash: await send(params, token.approve(spender, amount), "approval") };
  },
};

/**
 * Whether the token refuses to move an allowance from one non-zero value straight to another.
 *
 * Mainnet USDT is the one that matters:
 *   require(!((_value != 0) && (allowed[msg.sender][_spender] != 0)))
 * A payer holding any leftover allowance could otherwise never be approved, and would see a bare
 * revert with nothing explaining it.
 *
 * Probed with a RAW call rather than `staticCall`: staticCall decodes the result against our
 * fragment, which declares `returns (bool)`, and USDT's approve returns nothing at all — so
 * staticCall throws BAD_DATA on the very token this exists for, and every USDT approval would
 * pay for a reset it did not need. A raw call returns bytes and decodes nothing.
 */
async function refusesOverwrite(
  params: ApprovalParams,
  token: Contract,
  spender: string,
  amount: bigint,
): Promise<boolean> {
  const data = token.interface.encodeFunctionData("approve", [spender, amount]);
  try {
    await requireSigner(params).call({ to: params.token, data });
    return false;
  } catch (error) {
    // ONLY an on-chain refusal may take the reset branch. An RPC timeout or a rate limit must
    // propagate as itself: answering one by zeroing a working allowance, and then possibly
    // failing to restore it, would leave the payer worse off than not calling at all.
    if (isRevert(error)) return true;
    throw error;
  }
}

function isRevert(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "CALL_EXCEPTION";
}
