/**
 * Value normalizers shared by the TVM witness builders.
 *
 * The Go encoders take `[32]byte` and `*big.Int`, so Go cannot be handed a 31-byte depositId or a
 * negative amount, and it renders one canonical form. These helpers apply the same rules to
 * TypeScript's string inputs. Addresses are normalized by `normalizeAddress` in tron-address.ts,
 * which validates the base58check checksum; every builder goes through it.
 */

import { getBytes, hexlify } from 'ethers';
import { maskChainId } from './chain-id';

/**
 * A bytes32 witness member as lowercase 0x + 64 hex, matching Go's
 * `common.BytesToHash(v[:]).Hex()`.
 *
 * @throws if `value` is not valid hex or is not exactly 32 bytes. A short value is
 * REJECTED rather than left-padded: silently padding would sign a digest over a
 * different depositId than the caller meant, and the escrow has no rescue path.
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
 * A uint256 witness member as a decimal string, matching Go's
 * `(*big.Int).String()`.
 *
 * @throws if `value` is not an integer or is negative. `uint256` has no negative
 * range, and `ethers` would otherwise encode -1 as 2^256 - 1.
 */
export function normalizeUint256(label: string, value: bigint | string): string {
  let n: bigint;
  try {
    n = BigInt(value);
  } catch {
    throw new Error(
      `${label} must be an integer (bigint or decimal string), got ${JSON.stringify(value)}`,
    );
  }
  if (n < 0n) {
    throw new Error(`${label} must be non-negative (uint256), got ${n.toString()}`);
  }
  return n.toString();
}

/**
 * A raw Tron `block.chainid` masked to its lower 4 bytes and rendered as a
 * lowercase hex string — the two Tron-specific steps in one place.
 *
 * The mask is not cosmetic: Tron's TIP-712 domain uses a uint32 chainId, so a
 * signature produced over the unmasked value verifies against nothing. The hex
 * rendering matches Go's `math.HexOrDecimal256` marshalling; the digest is invariant to it.
 */
export function maskedChainIdToHex(chainId: number): string {
  if (!Number.isSafeInteger(chainId) || chainId < 0) {
    throw new Error(`chainId must be a non-negative safe integer, got ${chainId}`);
  }
  return `0x${maskChainId(chainId).toString(16)}`;
}
