/**
 * Source-chain adapter registry. Selects the per-chain build/sign implementation by
 * the CAIP-2 namespace of the source network, so the client stays chain-agnostic.
 */

import { evmAdapter } from './evm';
import { solanaAdapter } from './solana';
import { stellarAdapter } from './stellar';
import { tronAdapter } from './tron';
import type { ChainAdapter } from './types';

/**
 * Return the adapter for a source network. EVM (`eip155:*`), Solana (`solana:*`),
 * Stellar (`stellar:*`) and Tron (`tron:*`) are supported. An unsupported namespace throws rather than silently
 * producing an unusable payment.
 */
export function getChainAdapter(network: string): ChainAdapter {
  const namespace = network.split(':')[0];
  switch (namespace) {
    case 'eip155':
      return evmAdapter;
    case 'solana':
      return solanaAdapter;
    case 'stellar':
      return stellarAdapter;
    case 'tron':
      return tronAdapter;
    default:
      throw new Error(
        `atum-escrow: unsupported source chain namespace '${namespace}' (network ${network})`,
      );
  }
}

export type { ChainAdapter, AuthSigner, EscrowSigner, SolanaSigner, StellarSigner } from './types';
