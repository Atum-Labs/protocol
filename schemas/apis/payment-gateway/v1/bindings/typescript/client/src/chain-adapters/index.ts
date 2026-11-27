import type { ChainAdapter } from './types';
import { evmAdapter } from './evm';
import { tronAdapter } from './tron';
import { solanaAdapter } from './solana';
import { stellarAdapter } from './stellar';

export type { ChainAdapter, ChainDefaults, ChainEscrow, ContractFieldOverrides } from './types';

const adapters: Record<string, ChainAdapter> = {
  eip155: evmAdapter,
  tron: tronAdapter,
  solana: solanaAdapter,
  stellar: stellarAdapter,
};

export function getChainAdapter(sourceChainId: string): ChainAdapter {
  // CAIP-2 namespaces are lowercase, so routing on the lowercased one keeps a supported chain
  // routable whatever the caller typed. The reference is left alone: base58 is case-sensitive.
  const prefix = sourceChainId.split(':')[0]?.toLowerCase() ?? '';
  const adapter = adapters[prefix];
  if (!adapter) throw new Error(`Unsupported source chain: ${sourceChainId}`);
  return adapter;
}

/**
 * Reverse-lookup a Turnkey address format to its CAIP-2 namespace via the registry.
 * Returns undefined if no adapter claims it.
 */
export function namespaceForTurnkeyAddressFormat(addressFormat: string): string | undefined {
  for (const [namespace, adapter] of Object.entries(adapters)) {
    if (
      adapter.turnkeyAddressFormat !== undefined &&
      adapter.turnkeyAddressFormat === addressFormat
    )
      return namespace;
  }
  return undefined;
}
