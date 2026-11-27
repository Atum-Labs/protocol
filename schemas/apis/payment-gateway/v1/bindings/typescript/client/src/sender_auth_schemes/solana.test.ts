/**
 * Unit tests for the Solana deposit helpers: u64 encoding, base58 keys and replay nonces.
 */

import {
  encodeU64LE,
  base58ToBytes,
  bytesToHex,
  hexToBytes,
  generateSolanaNonce,
  MAX_VALID_SLOT,
} from './solana';
import { REPLAY_BUCKETS } from '@atum-labs/solana-escrow-encoding';

import bs58 from 'bs58';

const TEST_DEPOSITOR = bs58.encode(new Uint8Array(32).fill(0x02));

describe('Solana deposit helpers', () => {
  describe('encodeU64LE', () => {
    it('should encode 0 correctly', () => {
      const result = encodeU64LE(0n);
      expect(Array.from(result)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('should encode small values in little-endian', () => {
      const result = encodeU64LE(100n);
      expect(result[0]).toBe(100);
      expect(result[1]).toBe(0);
    });

    it('should encode 1000000 correctly', () => {
      // 1000000 = 0x0F4240
      const result = encodeU64LE(1000000n);
      expect(result[0]).toBe(0x40);
      expect(result[1]).toBe(0x42);
      expect(result[2]).toBe(0x0f);
      for (let i = 3; i < 8; i++) expect(result[i]).toBe(0);
    });

    it('should handle large uint64 values', () => {
      const maxU64 = (1n << 64n) - 1n;
      const result = encodeU64LE(maxU64);
      for (let i = 0; i < 8; i++) expect(result[i]).toBe(0xff);
    });
  });

  describe('base58ToBytes', () => {
    it('should decode known base58 addresses to 32 bytes', () => {
      const bytes = base58ToBytes(TEST_DEPOSITOR);
      expect(bytes.length).toBe(32);
      // All bytes should be 0x02
      for (const b of bytes) expect(b).toBe(0x02);
    });

    it('should roundtrip base58 encode/decode', () => {
      const original = new Uint8Array(32).fill(0xab);
      const encoded = bs58.encode(original);
      const decoded = base58ToBytes(encoded);
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });

    it('should throw for invalid length', () => {
      // A 20-byte value (not 32)
      const short = bs58.encode(new Uint8Array(20));
      expect(() => base58ToBytes(short)).toThrow('Invalid Solana public key length');
    });
  });

  describe('bytesToHex / hexToBytes', () => {
    it('round-trips with and without the 0x prefix', () => {
      const bytes = new Uint8Array([0, 1, 254, 255]);
      expect(bytesToHex(bytes)).toBe('0x0001feff');
      expect(Array.from(hexToBytes('0x0001feff'))).toEqual([0, 1, 254, 255]);
      expect(Array.from(hexToBytes('0001feff'))).toEqual([0, 1, 254, 255]);
    });
  });

  describe('generateSolanaNonce', () => {
    it('should generate nonces with valid slots', () => {
      for (let i = 0; i < 100; i++) {
        const nonce = generateSolanaNonce();
        const slot = Number(nonce & 0xffn);
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(slot).toBeLessThanOrEqual(MAX_VALID_SLOT);
      }
    });

    it('should generate nonces with valid bucket IDs', () => {
      for (let i = 0; i < 100; i++) {
        const nonce = generateSolanaNonce();
        const bucket = Number(nonce >> 32n);
        expect(bucket).toBeGreaterThanOrEqual(0);
        expect(bucket).toBeLessThan(REPLAY_BUCKETS);
      }
    });
  });
});
