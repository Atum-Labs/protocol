import { describe, it, expect } from 'vitest';
import { Pubkey } from './pubkey';
import { encodeU64LE } from './encoding-utils';
import { generateNonce, REPLAY_SLOTS, REPLAY_BUCKETS } from './nonce-generator';

// NOTE: the deposit / reserve / release / refund hash spec is validated in
// parity-golden.test.ts against the AUTHORITATIVE, program-sourced golden at
// ../../parity-golden.json (Rust + Go + TS all agree on one source of truth).
// This file keeps only the unit-level tests for the primitives.

// A fixed non-zero pubkey hex used purely to exercise Pubkey parsing helpers.
const SAMPLE_PUBKEY_HEX =
  '0202020202020202020202020202020202020202020202020202020202020202';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('encodeU64LE', () => {
  it('should encode numbers in little-endian', () => {
    expect(bytesToHex(encodeU64LE(1000000n))).toBe('40420f0000000000');
    expect(bytesToHex(encodeU64LE(100n))).toBe('6400000000000000');
    // 1700000000 = 0x6553F100, little-endian: 00 F1 53 65 00 00 00 00
    expect(bytesToHex(encodeU64LE(1700000000n))).toBe('00f1536500000000');
  });
});

describe('Pubkey', () => {
  it('should parse from hex', () => {
    const pk = Pubkey.fromHex(SAMPLE_PUBKEY_HEX);
    expect(pk.toHex()).toBe(SAMPLE_PUBKEY_HEX);
  });

  it('should handle 0x prefix', () => {
    const pk = Pubkey.fromHex('0x' + SAMPLE_PUBKEY_HEX);
    expect(pk.toHex()).toBe(SAMPLE_PUBKEY_HEX);
  });

  it('should detect zero pubkey', () => {
    const zeroPk = Pubkey.fromHex('0000000000000000000000000000000000000000000000000000000000000000');
    expect(zeroPk.isZero()).toBe(true);

    const nonZeroPk = Pubkey.fromHex(SAMPLE_PUBKEY_HEX);
    expect(nonZeroPk.isZero()).toBe(false);
  });
});

describe('generateNonce', () => {
  it('should produce nonces with valid slot and bucket', () => {
    for (let i = 0; i < 100; i++) {
      const nonce = generateNonce();
      const slot = Number(nonce & 0xFFn);
      const bucketID = Number(nonce >> 32n);

      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(REPLAY_SLOTS);
      expect(bucketID).toBeGreaterThanOrEqual(0);
      expect(bucketID).toBeLessThan(REPLAY_BUCKETS);
    }
  });

  it('should draw buckets only from the bounded set, and vary both fields', () => {
    const buckets = new Set<number>();
    const slots = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const nonce = generateNonce();
      buckets.add(Number(nonce >> 32n));
      slots.add(Number(nonce & 0xFFn));
    }
    // A field stuck on a constant stays inside its bounds while collapsing the collision
    // space, which the range assertions above cannot see.
    expect(buckets.size).toBeGreaterThan(REPLAY_BUCKETS / 2);
    expect(slots.size).toBeGreaterThan(REPLAY_SLOTS / 2);
  });
});
