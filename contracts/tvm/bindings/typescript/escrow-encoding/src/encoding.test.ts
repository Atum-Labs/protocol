import { describe, it, expect } from 'vitest';
import { maskChainId } from './chain-id';

describe('maskChainId', () => {
  it('should mask to 4 bytes', () => {
    // Tron Shasta chain ID
    const tronShasta = 2494104990;
    const masked = maskChainId(tronShasta);
    expect(masked).toBe((tronShasta & 0xFFFFFFFF) >>> 0);
    expect(masked).toBeGreaterThan(0);
  });

  it('should be identity for small chain IDs', () => {
    expect(maskChainId(1)).toBe(1);
    expect(maskChainId(137)).toBe(137);
    expect(maskChainId(42161)).toBe(42161);
  });
});
