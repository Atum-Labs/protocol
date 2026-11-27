import { ethers } from 'ethers';

/**
 * Generates a random 256-bit nonce for Permit2 authorization.
 *
 * @returns A 0x-prefixed hex string representing 32 random bytes
 */
export function generateNonce(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}
