import type { ChainAdapter } from '../types.js';
import { namespaceOf } from '../chain-id.js';
import { evmAdapter } from './evm.js';
import { tronAdapter } from './tron.js';
import { solanaAdapter } from './solana.js';
import { stellarAdapter } from './stellar.js';

/** Each supported CAIP-2 namespace and its adapter. */
export const CHAIN_ADAPTERS: Readonly<Record<string, ChainAdapter>> = {
  eip155: evmAdapter,
  tron: tronAdapter,
  solana: solanaAdapter,
  stellar: stellarAdapter,
};

/** Resolve the sender_auth adapter for a CAIP-2 network by its namespace prefix. */
export function getChainAdapter(caip2: string): ChainAdapter {
  const adapter = CHAIN_ADAPTERS[namespaceOf(caip2)];
  if (!adapter) {
    throw new Error(`sender_auth: unsupported source chain '${caip2}'`);
  }
  return adapter;
}
