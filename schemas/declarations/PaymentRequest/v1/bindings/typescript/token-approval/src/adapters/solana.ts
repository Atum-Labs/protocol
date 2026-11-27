import type { TokenApprovalAdapter } from "./types.js";

/**
 * Solana has no allowance to grant: the signed deposit authorizes the transfer itself, through
 * an escrow delegate created out of band. So there is nothing to approve and nothing to check.
 *
 * `applicable: false` makes that a reported outcome rather than a silent success — callers are
 * told no approval is needed, and the read/write methods are never reached.
 */
export const solanaAdapter: TokenApprovalAdapter = {
  applicable: false,

  resolveSpender() {
    throw new Error("token_approval: Solana does not use a Permit2-style allowance");
  },

  async senderAddress() {
    throw new Error("token_approval: Solana does not use a Permit2-style allowance");
  },

  async readAllowance() {
    throw new Error("token_approval: Solana does not use a Permit2-style allowance");
  },

  async approve() {
    throw new Error("token_approval: Solana does not use a Permit2-style allowance");
  },
};
