import { keccak_256 } from '@noble/hashes/sha3';

/**
 * Encodes a bigint as 8-byte little-endian Uint8Array.
 * This matches Solana/Borsh convention and Rust's `to_le_bytes()`.
 */
export function encodeU64LE(value: bigint): Uint8Array {
  const buffer = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    buffer[i] = Number(v & 0xffn);
    v = v >> 8n;
  }
  return buffer;
}

/**
 * Computes the Keccak-256 hash of the provided data.
 * This matches Solana's `solana_program::keccak::hashv()`.
 *
 * Note: Keccak-256 is NOT the same as SHA3-256.
 * - Keccak-256 uses the pre-NIST padding scheme
 * - SHA3-256 uses the NIST-specified domain separation padding
 *
 * Solana uses the original Keccak-256 (same as Ethereum).
 */
export function keccak256(...data: Uint8Array[]): Uint8Array {
  // Concatenate all data
  const totalLength = data.reduce((sum, arr) => sum + arr.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of data) {
    combined.set(arr, offset);
    offset += arr.length;
  }
  return keccak_256(combined);
}

/**
 * Converts a string to Uint8Array using UTF-8 encoding.
 */
export function stringToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Checks if a 32-byte array is all zeros.
 */
export function isZeroBytes32(data: Uint8Array): boolean {
  if (data.length !== 32) return false;
  return data.every(b => b === 0);
}
