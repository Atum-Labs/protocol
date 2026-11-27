/**
 * Value normalizers shared by the witness builders.
 *
 * The Go encoders take `[32]byte`, `common.Address` and `*big.Int`, so Go cannot be handed a
 * 31-byte depositId, a non-hex address or a negative amount, and it renders one canonical form
 * (lowercase 0x-hex for bytes32, EIP-55 for addresses, decimal for integers). These helpers apply
 * the same rules to TypeScript's string inputs, so the serialized prehash is byte-comparable with
 * Go's, not merely digest-equivalent.
 */

import { getAddress, getBytes, hexlify } from 'ethers';

/**
 * A bytes32 witness member as lowercase 0x + 64 hex, matching Go's
 * `common.BytesToHash(v[:]).Hex()`.
 *
 * @throws if `value` is not valid hex or is not exactly 32 bytes. A short value
 * is REJECTED rather than left-padded: silently padding would let a caller sign
 * a digest over a different depositId than the one it meant, and the escrow has
 * no rescue path for a deposit whose witness cannot be reproduced.
 */
export function normalizeBytes32(label: string, value: string): string {
  let bytes: Uint8Array;
  try {
    bytes = getBytes(value);
  } catch {
    throw new Error(`${label} must be 0x-prefixed hex (32 bytes), got ${JSON.stringify(value)}`);
  }
  if (bytes.length !== 32) {
    throw new Error(`${label} must be exactly 32 bytes, got ${bytes.length}`);
  }
  return hexlify(bytes);
}

/**
 * An address witness member in EIP-55 checksum form, matching Go's
 * `common.Address.Hex()`. Accepts any casing; rejects a non-address.
 *
 * The digest is invariant to address casing (`ethers` normalizes internally),
 * but the serialized prehash is not, and Go always emits the checksummed form.
 */
export function normalizeAddressField(label: string, value: string): string {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${label} must be a 20-byte hex address, got ${JSON.stringify(value)}`);
  }
}

/**
 * A uint256 witness member as a decimal string, matching Go's
 * `(*big.Int).String()`.
 *
 * @throws if `value` is not an integer or is negative. `uint256` has no negative
 * range, and `ethers` would otherwise encode a negative as its two's-complement
 * bit pattern — signing a digest over 2^256 - 1 while the caller meant -1.
 */
export function normalizeUint256(label: string, value: bigint | string): string {
  let n: bigint;
  try {
    n = BigInt(value);
  } catch {
    throw new Error(`${label} must be an integer (bigint or decimal string), got ${JSON.stringify(value)}`);
  }
  if (n < 0n) {
    throw new Error(`${label} must be non-negative (uint256), got ${n.toString()}`);
  }
  return n.toString();
}

/**
 * A chain ID as a lowercase hex string, matching how Go's `math.HexOrDecimal256` marshals the
 * domain's `chainId`. The EIP-712 digest is invariant to the representation; the JSON is not.
 */
export function chainIdToHex(chainId: number): string {
  if (!Number.isSafeInteger(chainId) || chainId < 0) {
    throw new Error(`chainId must be a non-negative safe integer, got ${chainId}`);
  }
  return `0x${chainId.toString(16)}`;
}
