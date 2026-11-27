/**
 * Masks a chain ID to 4 bytes for Tron TIP-712 compatibility.
 *
 * Tron's EIP-712 implementation uses a 4-byte chain ID (uint32),
 * unlike EVM which uses the full numeric value.
 *
 * @param chainId - The raw chain ID
 * @returns The chain ID masked to 32 bits (unsigned)
 */
export function maskChainId(chainId: number): number {
  return (chainId & 0xFFFFFFFF) >>> 0;
}
