import { ethers } from 'ethers';

/**
 * Computes the escrow's deposit id: keccak256(abi.encode(depositor, signature, nonce)), as
 * Escrow.sol derives it on deposit.
 *
 * @param depositor - The depositor's EVM-formatted address (0x...); convert a Tron base58 address first
 * @param signature - The Permit2 signature (hex string)
 * @param nonce - The Permit2 nonce (uint256 as hex or decimal string)
 * @returns The deposit id as a 0x-prefixed hex string
 */
export function computePaymentIdV2(depositor: string, signature: string, nonce: string): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(['address', 'bytes', 'uint256'], [depositor, signature, nonce]);
  return ethers.keccak256(encoded);
}
