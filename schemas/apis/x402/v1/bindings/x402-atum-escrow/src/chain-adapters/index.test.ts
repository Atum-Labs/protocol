import { describe, it, expect } from 'vitest';
import { getChainAdapter } from './index';
import { evmAdapter } from './evm';
import { solanaAdapter } from './solana';
import { tronAdapter } from './tron';

describe('getChainAdapter (source-chain dispatch)', () => {
  it('routes an eip155 network to the EVM adapter', () => {
    expect(getChainAdapter('eip155:42161')).toBe(evmAdapter);
  });

  it('routes a solana network to the Solana adapter', () => {
    expect(getChainAdapter('solana:localnet')).toBe(solanaAdapter);
  });

  it('routes a tron network to the Tron adapter', () => {
    expect(getChainAdapter('tron:shasta')).toBe(tronAdapter);
  });

  // Namespaces not yet wired (or malformed) must fail loudly here rather than
  // silently mis-route. `EIP155:1` (wrong case) proves the match is exact.
  it.each(['EIP155:1', 'bip122:x', ''])(
    'throws for unsupported/malformed namespace %j',
    (network) => {
      expect(() => getChainAdapter(network)).toThrow(/unsupported source chain/);
    },
  );

  // EVM (0x-hex) and Solana (base58) already match their witness form, so
  // normalizeRoleAddress is identity there; only Tron converts (see tron.test.ts).
  it('normalizeRoleAddress is identity for EVM', () => {
    const evm = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
    expect(evmAdapter.normalizeRoleAddress(evm)).toBe(evm);
  });

  it('normalizeRoleAddress is identity for Solana', () => {
    const sol = 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq';
    expect(solanaAdapter.normalizeRoleAddress(sol)).toBe(sol);
  });
});
