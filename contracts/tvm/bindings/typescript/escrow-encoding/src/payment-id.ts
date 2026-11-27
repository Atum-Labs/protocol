/**
 * TVM (Tron) deposit id derivation: keccak256(abi.encode(depositor, signature, nonce)).
 *
 * Byte-for-byte counterpart of the Go encoder (payment_id_encoder.go). The depositor may be base58
 * ("T..."), 41-prefixed hex or plain 20-byte hex; it is normalized to its bare 20-byte form before
 * abi.encode(address), as the Go encoder does, so every form of one address derives the same id.
 */

import { AbiCoder, keccak256 } from 'ethers';
import { normalizeAddress } from './tron-address';

/**
 * Computes the deposit id keccak256(abi.encode(depositor, signature, nonce)), with the depositor
 * normalized as above.
 *
 * @param depositor base58 / 41-hex / plain-hex Tron address
 * @param signature Permit2 signature, hex string
 * @param nonce     Permit2 nonce as a base-10 decimal string. Decimal only: the
 *                  Go encoder parses the nonce base-10 (`big.Int.SetString(_, 10)`),
 *                  so a `0x`-prefixed/hex nonce would be read with a different
 *                  radix on the two sides and silently produce a different
 *                  deposit id. It is refused here rather than accepted by `ethers`.
 * @returns the 0x-prefixed 32-byte deposit id
 */
export function computePaymentId(depositor: string, signature: string, nonce: string): string {
  if (!/^[0-9]+$/.test(nonce)) {
    throw new Error(`invalid nonce (expected base-10 decimal): ${nonce}`);
  }
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes', 'uint256'],
    [normalizeAddress(depositor), signature, nonce],
  );
  return keccak256(encoded);
}
