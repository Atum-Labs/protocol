/**
 * Tron address normalization, byte-for-byte faithful to the Go gateway
 * (tvm_address.go `NormalizeAddress` / `ConvertBase58ToHex`). This is the
 * originator side where a fat-fingered "T…" address originates, so it must
 * reject exactly what the on-chain verifier rejects — otherwise a typo'd or
 * malformed address would be signed here and only fail downstream.
 *
 * Shared by the paymentId derivation (payment-id.ts) and the Permit2 deposit
 * encoder (deposit-encoder.ts), and re-exported for SDK consumers.
 */

import { sha256, hexlify } from 'ethers';
import bs58 from 'bs58';

const TVM_MAINNET_PREFIX = '41';

/**
 * Convert a Tron base58 address (e.g. "TYaKH9ApqbdftVGSnTMPVL9kp1S5AQBQSs") to
 * its 21-byte hex form (0x41 mainnet prefix ‖ 20-byte address), without a `0x`
 * prefix. `normalizeAddress` then strips the 0x41 to get the bare 20-byte form
 * that TIP-712 hashes.
 *
 * A Tron base58 address is base58check: 0x41 ‖ 20-byte address ‖ 4-byte
 * checksum (25 bytes), where the checksum is the first 4 bytes of
 * sha256(sha256(0x41 ‖ address)). The checksum MUST be validated: the Go
 * gateway (address.Base58ToAddress) rejects a bad checksum, so accepting one
 * here would sign a wrong/typo'd address that only fails on-chain later.
 */
export function base58ToHex(base58Address: string): string {
  if (!base58Address || !base58Address.startsWith('T')) {
    throw new Error(`Invalid Tron base58 address: ${base58Address}`);
  }

  const decoded = bs58.decode(base58Address); // throws on non-base58 characters
  if (decoded.length !== 25) {
    throw new Error(`Invalid Tron base58 length (expected 25 bytes): ${base58Address}`);
  }

  const payload = decoded.slice(0, 21); // 0x41 ‖ 20-byte address
  const checksum = hexlify(decoded.slice(21)).slice(2); // last 4 bytes, hex
  const computed = sha256(sha256(payload)).slice(2, 10); // first 4 bytes, hex
  if (checksum !== computed) {
    throw new Error(`Invalid Tron base58 checksum: ${base58Address}`);
  }

  return hexlify(payload).slice(2); // 42 hex chars (21 bytes, 0x41-prefixed)
}

/**
 * Normalize a Tron address (base58, or hex with an optional 0x / 0x41 prefix) to
 * the canonical TIP-712 hex form: 0x-prefixed, 20 bytes (40 hex chars). This is
 * the wire format `wallet.signTypedData` expects for an `address`.
 */
export function normalizeAddress(address: string): string {
  if (!address) {
    throw new Error('Empty address');
  }

  let hexAddress = address;

  if (address.startsWith('T')) {
    hexAddress = base58ToHex(address);
  }

  // Strip a lowercase `0x` only — case-sensitive, matching the Go gateway
  // (NormalizeAddress does `TrimPrefix("0x")`). An uppercase `0X` is left in
  // place so the length/hex checks below reject it, exactly as the gateway does.
  hexAddress = hexAddress.replace(/^0x/, '');

  // Strip the 0x41 Tron mainnet marker, which only the 21-byte spelling carries.
  // A 20-byte body is free to begin with 0x41 itself, so gating on the leading
  // characters alone would eat the first byte of one address in 256. Length
  // selects which shape an input is; the marker must then be exactly 41.
  if (hexAddress.length === 42 && hexAddress.startsWith(TVM_MAINNET_PREFIX)) {
    hexAddress = hexAddress.substring(2);
  }

  if (hexAddress.length !== 40) {
    throw new Error(`Invalid address length: expected 40 chars, got ${hexAddress.length}`);
  }

  if (!/^[0-9a-fA-F]{40}$/.test(hexAddress)) {
    throw new Error('Invalid hex address format');
  }

  return '0x' + hexAddress.toLowerCase();
}
