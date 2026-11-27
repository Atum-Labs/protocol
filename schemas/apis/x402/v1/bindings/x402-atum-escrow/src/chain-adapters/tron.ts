/**
 * Tron source address/asset helpers. The TIP-712 Permit2 escrow-deposit crypto (build,
 * sign, recover) now lives in the shared `@atum-labs/payment-request-sender-auth` SDK;
 * this adapter only resolves the two chain-form values the SDK does not: the payer's
 * `source.account` as a canonical Tron base58 address, and the CAIP-19 (`trc20`) asset
 * identifier. The signer is a secp256k1 `ethers.Wallet` (`EscrowSigner`), same as EVM.
 */

import { ethers } from 'ethers';
import bs58 from 'bs58';
import { normalizeAddress } from '@atum-labs/tvm-escrow-encoding';
import type { AuthSigner, ChainAdapter } from './types';

/**
 * Convert a 0x-prefixed 20-byte (EVM-style, secp256k1-derived) address to a canonical Tron
 * base58 address: base58check over `0x41 ‖ 20-byte address ‖ sha256(sha256(...))[:4]`.
 * Needed only for the source-account form (`getAddress`).
 */
function hexToTronBase58(hex20: string): string {
  const body = ethers.getBytes(hex20); // 20 bytes
  const payload = new Uint8Array(21);
  payload[0] = 0x41; // Tron mainnet address prefix
  payload.set(body, 1);
  const checksum = ethers.getBytes(ethers.sha256(ethers.sha256(payload))).slice(0, 4);
  const full = new Uint8Array(25);
  full.set(payload, 0);
  full.set(checksum, 21);
  return bs58.encode(full);
}

export const tronAdapter: ChainAdapter = {
  async getAddress(signer: AuthSigner): Promise<string> {
    if (!('getAddress' in signer)) {
      throw new Error('tron adapter requires an EIP-712 (secp256k1) typed-data signer');
    }
    // The secp256k1 key yields the same 20 bytes as EVM; present it as canonical Tron base58.
    return hexToTronBase58(await signer.getAddress());
  },

  assetIdentifier(network: string, asset: string): string {
    return `${network}/trc20:${asset}`;
  },

  // Tron `/defaults` returns base58 (`T…`) roles, but the signed witness carries the
  // canonical 20-byte hex (the tvm deposit-encoder runs this same `normalizeAddress`).
  // Reuse it so the top-level role fields are byte-identical to the witness roles.
  normalizeRoleAddress(addr: string): string {
    return normalizeAddress(addr);
  },
};
