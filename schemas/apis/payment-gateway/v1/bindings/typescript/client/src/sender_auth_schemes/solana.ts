/**
 * Solana deposit helpers: replay nonces and base58/hex encoding.
 *
 * Deposit authorizations are built through the shared sender_auth adapter
 * (`getChainAdapter(chainId).buildAuthMessage(...)`), which commits the destination and reads the
 * escrow's signature domain. For the raw primitive, use computeDepositHashV2 from
 * @atum-labs/solana-escrow-encoding (contracts/svm/bindings/typescript/escrow-encoding), the encoding shared with the
 * on-chain program and the Go signing library.
 */

import { hexlify, getBytes } from 'ethers';
import bs58 from 'bs58';
import { encodeU64LE, generateNonce, MAX_VALID_SLOT } from '@atum-labs/solana-escrow-encoding';

// Re-exported as part of this package's public API.
export { encodeU64LE, MAX_VALID_SLOT };

// ─── Constants ───────────────────────────────────────────────────────────────

/** Replay horizon in seconds — deposit deadline must be within this window of issuedAt. */
export const REPLAY_HORIZON_SECS = 128;

/**
 * Widest bucket ID the replay nonce layout carries. Generated nonces draw from the smaller
 * bounded set the escrow-encoding package defines, which keeps the replay_bucket PDAs reusable.
 */
export const TOTAL_BUCKETS = 131072;

// ─── Encoding Utilities ──────────────────────────────────────────────────────

/**
 * Decodes a Base58-encoded Solana public key to a 32-byte Uint8Array.
 *
 * @throws If the decoded key is not 32 bytes.
 */
export function base58ToBytes(address: string): Uint8Array {
  const bytes = bs58.decode(address);
  if (bytes.length !== 32) {
    throw new Error(`Invalid Solana public key length: expected 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * Converts a Uint8Array to a 0x-prefixed hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return hexlify(bytes);
}

/**
 * Converts a hex string (with or without 0x prefix) to a Uint8Array.
 */
export function hexToBytes(hex: string): Uint8Array {
  return getBytes(hex.startsWith('0x') ? hex : '0x' + hex);
}

// ─── Nonce ───────────────────────────────────────────────────────────────────

/**
 * Generates a valid nonce for Solana replay protection (upper 32 bits: random
 * bucket, lower 8 bits: random slot 0..MAX_VALID_SLOT), using a CSPRNG with
 * rejection sampling.
 *
 * @returns A bigint nonce suitable for the deposit message
 */
export function generateSolanaNonce(): bigint {
  return generateNonce();
}
