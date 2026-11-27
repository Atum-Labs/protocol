/**
 * Payer-side Permit2 approval for the source token an escrow deposit moves.
 *
 * On EVM and Tron the escrow moves the source token through Permit2, so the payer must have
 * approved Permit2 on that token BEFORE paying. Without it the payment is built, signed and
 * accepted by the gateway, and then the deposit reverts on-chain at settlement — a late and
 * misleading failure. Solana authorizes the transfer inside the signed deposit itself, so
 * there is nothing to approve there.
 *
 * Worth arranging before the payment is signed: a deposit that reverts is a terminal
 * settlement failure, and a terminal failure is bound to the request identifier that produced
 * it, so re-attempting then needs a NEW identifier. Getting the allowance right up front keeps
 * the identifier usable.
 *
 * This package reads chain state and broadcasts a transaction, which is why it is separate
 * from the sender-auth SDK next door: that one is pure, offline and byte-parity-tested against
 * Go. The caller supplies the connected signer, so this package never chooses an RPC endpoint.
 */

import { effectiveRequirement, isAllowanceSufficient, resolveApprovalAmount } from "./allowance.js";
import { approvalAdapterFor } from "./adapters/index.js";
import { assertSenderIsOwner } from "./sender.js";
import type { ApprovalParams, EnsureApprovalResult } from "./types.js";

export {
  UNLIMITED_APPROVAL,
  UNLIMITED_APPROVAL_FLOOR,
  effectiveRequirement,
  isAllowanceSufficient,
  resolveApprovalAmount,
} from "./allowance.js";
export { assertSenderIsOwner } from "./sender.js";
/**
 * Tells a broadcast-but-unseen approval apart from one that failed. Part of the public surface
 * because the distinction is only useful if a caller can act on it: a failure needs a new
 * approval, an unconfirmed one needs a look at the transaction and nothing else. Without this a
 * caller has to read an undocumented property off the error.
 */
export { isUnconfirmed } from "./adapters/unconfirmed.js";
export { approvalAdapterFor } from "./adapters/index.js";
export type { TokenApprovalAdapter } from "./adapters/index.js";
export type {
  ApprovalParams,
  EnsureApprovalResult,
  ConfirmationOptions,
  TronContractMethod,
  TronTokenContract,
  TronTransactionInfo,
  TronWebLike,
} from "./types.js";

/**
 * Whether a payment on these terms would need an approval transaction first.
 *
 * Read-only: it spends no gas and sends nothing, so it is safe to call on every payment as a
 * preflight. Returns false on Solana, which needs no approval at all.
 *
 * @remarks
 * Unlike a try-and-see, this reports the answer instead of acting on it — use it to tell a
 * payer what is about to happen, or to check whether a wallet is ready before asking for a
 * signature.
 */
export async function needsSourceApproval(params: ApprovalParams): Promise<boolean> {
  const adapter = approvalAdapterFor(params.network);
  if (!adapter.applicable) return false;
  const required = effectiveRequirement(params.requiredAllowance, params.approvalAmount);
  // Validated here too, and the result discarded: an amount that could never satisfy its own
  // requirement must fail the same way in both, or a preflight would answer "nothing to do"
  // for arguments the approval refuses outright.
  resolveApprovalAmount(params.approvalAmount, required);

  const spender = adapter.resolveSpender(params);
  const current = await adapter.readAllowance(params, spender);
  // Same requirement ensureSourceApproval applies, so the two cannot disagree about the same
  // arguments.
  return !isAllowanceSufficient(current, required);
}

/**
 * Ensure the payer has approved Permit2 to move the source token, so the escrow deposit does
 * not revert at settlement. Reads the current allowance and sends an approval only if it falls
 * short; the approval it sends is unlimited unless `approvalAmount` bounds it.
 *
 * Applies to EVM (`params.signer`) and Tron (`params.tronWeb`). On Solana it reports
 * `alreadySufficient` without touching the chain.
 *
 * @remarks
 * Not concurrency-safe: two overlapping calls for the same `(owner, token, spender)` may both
 * read a short allowance and both send an approval. They target the same value, so this only
 * wastes gas; serialize calls per token if that matters.
 */
export async function ensureSourceApproval(
  params: ApprovalParams,
): Promise<EnsureApprovalResult> {
  const adapter = approvalAdapterFor(params.network);
  if (!adapter.applicable) return { alreadySufficient: true };

  // A bounded approvalAmount stands in as its own requirement — see effectiveRequirement.
  const required = effectiveRequirement(params.requiredAllowance, params.approvalAmount);
  // Resolved before the allowance read so a bad pairing of approvalAmount and
  // requiredAllowance fails immediately, rather than after a network round trip.
  const amount = resolveApprovalAmount(params.approvalAmount, required);
  const spender = adapter.resolveSpender(params);

  const current = await adapter.readAllowance(params, spender);
  if (isAllowanceSufficient(current, required)) {
    return { alreadySufficient: true };
  }

  // Checked here, on the sending path only. Reading another account's allowance is a legitimate
  // preflight — a merchant can ask whether a payer is ready without holding their keys — but
  // granting one on their behalf is not something any client can do.
  assertSenderIsOwner(params.owner, await adapter.senderAddress(params));

  return { alreadySufficient: false, ...(await adapter.approve(params, spender, amount, current)) };
}
