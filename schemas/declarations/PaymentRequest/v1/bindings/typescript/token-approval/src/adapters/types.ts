import type { ApprovalParams } from "../types.js";

/**
 * Per-chain-family implementation of the three steps an approval needs. The sufficiency
 * decision itself is deliberately NOT here — it lives once in `allowance.ts` so every chain
 * answers "is this enough?" identically.
 */
export interface TokenApprovalAdapter {
  /**
   * Whether this chain family uses a Permit2-style allowance at all. When false, the other
   * methods are never called and an approval is reported as unnecessary rather than attempted.
   */
  readonly applicable: boolean;
  /** The contract to approve: the caller's, or the chain's canonical Permit2. */
  resolveSpender(params: ApprovalParams): string;
  /**
   * The account the caller's client would send the approval from, or undefined when the client
   * cannot say. Checked against `owner` before anything is broadcast — see `sender.ts`.
   */
  senderAddress(params: ApprovalParams): Promise<string | undefined>;
  /** Current owner -> spender allowance on `params.token`. */
  readAllowance(params: ApprovalParams, spender: string): Promise<bigint>;
  /**
   * Send the approval and wait for it to confirm.
   *
   * `current` is the allowance just read. It is passed in rather than re-read because only a
   * NON-ZERO allowance can run into a token that refuses to be overwritten in place, so a fresh
   * wallet must not pay for that check.
   */
  approve(
    params: ApprovalParams,
    spender: string,
    amount: bigint,
    current: bigint,
  ): Promise<ApprovalReceipt>;
}

/** What an approval actually sent. */
export interface ApprovalReceipt {
  txHash: string;
  /** Present only when the token forced a reset to zero first. */
  resetTxHash?: string;
}
