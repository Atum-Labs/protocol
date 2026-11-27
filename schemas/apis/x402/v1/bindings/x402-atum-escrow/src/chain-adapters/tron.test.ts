import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { normalizeAddress } from '@atum-labs/tvm-escrow-encoding';
import { tronAdapter } from './tron';

// Valid Shasta base58 token address lifted from the protocol tvm deposit-encoder golden vectors.
const TOKEN = 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';

// Deterministic throwaway secp256k1 key — safe to commit. Tron addresses are the same
// secp256k1-derived 20 bytes as EVM, so the signer is a plain ethers.Wallet.
const wallet = new ethers.Wallet('0x' + '11'.repeat(32));
const walletHex = wallet.address.toLowerCase(); // 0x-prefixed bare 20-byte hex

describe('tronAdapter.getAddress / assetIdentifier', () => {
  it('derives the source account as a base58 Tron address that normalizes back to the key', async () => {
    const account = await tronAdapter.getAddress(wallet);
    expect(account).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/); // canonical Tron base58
    expect(normalizeAddress(account).toLowerCase()).toBe(walletHex);
  });

  it('builds the CAIP-19 asset id with the trc20 namespace', () => {
    expect(tronAdapter.assetIdentifier('tron:shasta', TOKEN)).toBe(`tron:shasta/trc20:${TOKEN}`);
  });

  it('normalizeRoleAddress converts a base58 Tron role to the canonical 20-byte hex the witness carries', () => {
    const hex = tronAdapter.normalizeRoleAddress(TOKEN);
    expect(hex).toMatch(/^0x[0-9a-f]{40}$/);
    // Byte-identical to what the tvm deposit-encoder puts in the witness roles.
    expect(hex).toBe(normalizeAddress(TOKEN));
  });
});
