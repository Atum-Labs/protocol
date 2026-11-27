import { namespaceOf } from "@atum-labs/payment-request-sender-auth";
import { evmAdapter } from "./evm.js";
import { tronAdapter } from "./tron.js";
import { solanaAdapter } from "./solana.js";
import type { TokenApprovalAdapter } from "./types.js";

/**
 * Adapters by CAIP-2 namespace.
 *
 * Own-keys lookup only: a prototype member such as `constructor` is truthy, so an inherited
 * name would otherwise pass the guard and select an adapter for a network nobody supports.
 * The sender-auth SDK guards its chain-id maps the same way, for the same reason.
 */
const ADAPTERS: Record<string, TokenApprovalAdapter> = {
  eip155: evmAdapter,
  tron: tronAdapter,
  solana: solanaAdapter,
};

/** The approval adapter for a CAIP-2 network id, or a throw naming the unsupported namespace. */
export function approvalAdapterFor(network: string): TokenApprovalAdapter {
  const namespace = namespaceOf(network);
  const adapter = Object.hasOwn(ADAPTERS, namespace) ? ADAPTERS[namespace] : undefined;
  if (!adapter) {
    throw new Error(`token_approval: no approval adapter for network '${network}'`);
  }
  return adapter;
}

export type { TokenApprovalAdapter } from "./types.js";
