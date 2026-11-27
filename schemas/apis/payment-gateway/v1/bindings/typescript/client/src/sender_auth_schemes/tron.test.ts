import * as encoding from '@atum-labs/tvm-escrow-encoding';
import {
  base58ToHex,
  normalizeAddress,
  maskChainId,
  hashTvmPermitWitnessTransferFrom,
} from './tron';

describe('Tron sender auth helpers', () => {
  describe('base58ToHex', () => {
    it('should convert known Tron base58 addresses to hex', () => {
      const testCases = [
        {
          base58: 'T9yD14NjG6wxkArbchsTBKawgUVqYww3tQ',
          expectedHex: '41000000000022d473030f116ddee9f6b43ac78ba3',
        },
        {
          base58: 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N',
          // Shasta escrow address; verifies prefix preservation.
          expectedHex: undefined, // computed dynamically below
        },
      ];

      for (const tc of testCases) {
        const result = base58ToHex(tc.base58);
        expect(result).toMatch(/^41[0-9a-f]{40}$/);
        if (tc.expectedHex) {
          expect(result.toLowerCase()).toBe(tc.expectedHex);
        }
      }
    });

    it('should throw for invalid base58 addresses', () => {
      expect(() => base58ToHex('invalid')).toThrow('Invalid Tron base58 address');
      expect(() => base58ToHex('')).toThrow('Invalid Tron base58 address');
      expect(() => base58ToHex('0x1234')).toThrow('Invalid Tron base58 address');
    });
  });

  describe('normalizeAddress', () => {
    it('returns 0x-prefixed 20-byte hex from base58', () => {
      const result = normalizeAddress('T9yD14NjG6wxkArbchsTBKawgUVqYww3tQ');
      expect(result).toBe('0x000000000022d473030f116ddee9f6b43ac78ba3');
    });

    it('strips 0x and 41 prefixes', () => {
      expect(normalizeAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3')).toBe(
        '0x000000000022d473030f116ddee9f6b43ac78ba3',
      );
      expect(normalizeAddress('41000000000022D473030F116dDEE9F6B43aC78BA3')).toBe(
        '0x000000000022d473030f116ddee9f6b43ac78ba3',
      );
      expect(normalizeAddress('000000000022d473030f116ddee9f6b43ac78ba3')).toBe(
        '0x000000000022d473030f116ddee9f6b43ac78ba3',
      );
    });

    it('throws for invalid input', () => {
      expect(() => normalizeAddress('')).toThrow('Empty address');
      expect(() => normalizeAddress('invalid')).toThrow();
      expect(() => normalizeAddress('0x123')).toThrow('Invalid address length');
    });
  });

  // Rejection parity with the Go gateway NormalizeAddress (the on-chain
  // reference) and the @atum/tvm-escrow-encoding package: the gateway verifies
  // signatures on-chain, so any address the gateway rejects must be rejected
  // here too. Otherwise a mistyped or malformed address is signed on the
  // originator side and produces a wrong/invalid-address authorization that
  // only fails downstream — the exact silent failure base58check prevents.
  describe('normalizeAddress / base58ToHex — gateway rejection parity', () => {
    it('rejects a base58 address with a corrupted base58check checksum', () => {
      // TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py with only its checksum byte mutated.
      const badChecksum = 'TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4qS';
      expect(() => base58ToHex(badChecksum)).toThrow();
      expect(() => normalizeAddress(badChecksum)).toThrow();
    });

    it('accepts a 20-byte hex address whose first byte is 0x41', () => {
      // 0x41 is the base58check envelope marker, not part of the address body,
      // so it may only be stripped from the 21-byte (42-char) spelling. A bare
      // 20-byte body that happens to begin with 0x41 is an ordinary address:
      // stripping the marker here would truncate it to 19 bytes and silently
      // authorize a different account than the payer typed.
      expect(normalizeAddress('0x41aabbccddeeff00112233445566778899aabbcc')).toBe(
        '0x41aabbccddeeff00112233445566778899aabbcc',
      );
    });

    it('rejects an uppercase 0X prefix (gateway TrimPrefix is case-sensitive)', () => {
      // The gateway strips only a lowercase `0x`, so an otherwise-valid address
      // with an uppercase `0X` prefix is rejected there and must be rejected
      // here too — the SDK must not accept a form the verifier rejects.
      expect(() => normalizeAddress('0X000000000022d473030f116ddee9f6b43ac78ba3')).toThrow();
    });

    it('still accepts every valid form of the same address (regression)', () => {
      const want = '0x2e9fbe1886fa094573e3bd25c554e827873bb9fc';
      expect(normalizeAddress('TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py')).toBe(want);
      expect(normalizeAddress('0x412e9fbe1886fa094573e3bd25c554e827873bb9fc')).toBe(want);
      expect(normalizeAddress('0x2e9fbe1886fa094573e3bd25c554e827873bb9fc')).toBe(want);
    });
  });

  describe('maskChainId', () => {
    it('masks chain ID to lower 4 bytes', () => {
      expect(maskChainId(1)).toBe(1);
      expect(maskChainId(0xffffffff)).toBe(0xffffffff);
      expect(maskChainId(0x100000001)).toBe(1);
      expect(maskChainId(0xabcdef123456)).toBe(0xef123456);
    });

    it('passes through Shasta chain ID unchanged (already 4 bytes)', () => {
      // Tron Shasta block.chainid = 2494104990 = 0x94a9059e
      expect(maskChainId(2494104990)).toBe(2494104990);
    });
  });

  it('re-exports the shared TIP-712 digest function', () => {
    expect(hashTvmPermitWitnessTransferFrom).toBe(encoding.hashTvmPermitWitnessTransferFrom);
  });
});
