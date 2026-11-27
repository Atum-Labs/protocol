import { ethers } from 'ethers';

import type { ChainAdapter } from './types';
import { assertKeyMatchesSender } from './types';

export const evmAdapter: ChainAdapter = {
  turnkeyAddressFormat: 'ADDRESS_FORMAT_ETHEREUM',

  formatPrivateKey(key: string): string {
    return key.startsWith('0x') ? key : '0x' + key;
  },

  // Value-free: never interpolate the key. A malformed key would otherwise be
  // echoed by ethers.Wallet's "invalid BytesLike value" error.
  validatePrivateKey(key: string): void {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error('Invalid private key');
    }
  },

  // Called after validatePrivateKey, so ethers.Wallet won't echo a malformed key.
  verifyAddressMatchesKey(privateKey: string, address: string): void {
    const derived = new ethers.Wallet(privateKey).address;
    assertKeyMatchesSender(derived.toLowerCase() === address.toLowerCase(), address, derived);
  },
};
