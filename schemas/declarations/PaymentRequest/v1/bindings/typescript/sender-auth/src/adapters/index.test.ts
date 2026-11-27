import { describe, it, expect } from 'vitest';
import { getChainAdapter } from './index.js';

describe('getChainAdapter', () => {
  it('selects by CAIP-2 namespace prefix', () => {
    expect(getChainAdapter('eip155:1')).toBeDefined();
    expect(getChainAdapter('tron:mainnet')).toBeDefined();
    expect(getChainAdapter('solana:mainnet')).toBeDefined();
  });

  it('throws on an unsupported namespace', () => {
    expect(() => getChainAdapter('bitcoin:mainnet')).toThrow(/unsupported source chain/);
  });
});
