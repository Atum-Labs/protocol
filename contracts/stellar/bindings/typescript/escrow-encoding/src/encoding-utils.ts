import { keccak_256 } from '@noble/hashes/sha3';
import { AmountOutOfRangeError, EncodingError, InvalidFieldLengthError } from './errors';

/** i128::MAX: SEP-41 amounts are i128 and the contract only ever hashes non-negative ones. */
export const MAX_I128 = (1n << 127n) - 1n;

const MAX_U64 = (1n << 64n) - 1n;

/**
 * Encodes a bigint as 8-byte little-endian Uint8Array, as the contract's `u64::to_le_bytes`.
 * Values outside 0..=2^64-1 are rejected rather than silently truncated.
 */
export function encodeU64LE(value: bigint): Uint8Array {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) {
    throw new EncodingError('u64 out of range');
  }
  return encodeLE(value, 8);
}

/**
 * Encodes a non-negative i128 as 16 little-endian bytes (`amt16` in the layout doc). Negative values and
 * values above i128::MAX are rejected: the contract would encode a negative one as its two's-complement
 * u128, a digest no honest transaction can reach.
 */
export function encodeAmount16(value: bigint): Uint8Array {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_I128) {
    throw new AmountOutOfRangeError();
  }
  return encodeLE(value, 16);
}

function encodeLE(value: bigint, width: number): Uint8Array {
  const buffer = new Uint8Array(width);
  let v = value;
  for (let i = 0; i < width; i++) {
    buffer[i] = Number(v & 0xffn);
    v = v >> 8n;
  }
  return buffer;
}

/**
 * Computes the Keccak-256 hash of the provided data, as the host's `keccak256`.
 *
 * Note: Keccak-256 is NOT the same as SHA3-256. It uses the pre-NIST padding, as Ethereum and the Solana
 * port do.
 */
export function keccak256(...data: Uint8Array[]): Uint8Array {
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

/** Throws InvalidFieldLengthError unless the value is exactly 32 bytes. */
export function requireBytes32(field: string, data: Uint8Array): void {
  if (!(data instanceof Uint8Array) || data.length !== 32) {
    throw new InvalidFieldLengthError(field, data?.length ?? 0);
  }
}

/**
 * Checks if a 32-byte array is all zeros. A wrong-length array is not "zero": callers that need a width
 * check make it themselves.
 */
export function isZeroBytes32(data: Uint8Array): boolean {
  if (data.length !== 32) return false;
  return data.every((b) => b === 0);
}
