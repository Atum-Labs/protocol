import { ethers } from 'ethers';

import type { ChainAdapter, ChainDefaults, ContractFieldOverrides } from './types';
import { assertKeyMatchesSender } from './types';
import { normalizeAddress } from '../sender_auth_schemes/tron';

export const tronAdapter: ChainAdapter = {
  turnkeyAddressFormat: 'ADDRESS_FORMAT_TRON',

  resolveContractOverrides(sourceDefaults: ChainDefaults): ContractFieldOverrides {
    // Tron /v1/defaults returns base58 (`T…`) addresses; normalize them to the
    // canonical 20-byte hex form the on-chain verifier and the signed permit
    // witness use, so the request body matches. Single source of truth for the
    // Tron override — consumed by both the payment and quote paths, so they
    // cannot diverge.
    return {
      quote_selector: normalizeAddress(sourceDefaults.quoteSelector),
      fulfillment_verifier: {
        account: normalizeAddress(sourceDefaults.fulfillmentVerifierAccount),
        endpoint: sourceDefaults.fulfillmentVerifierEndpoint,
      },
    };
  },

  formatPrivateKey(key: string): string {
    return key.startsWith('0x') ? key.slice(2) : key;
  },

  // Value-free: never interpolate the key. A malformed key would otherwise be
  // echoed by ethers.Wallet's "invalid BytesLike value" error.
  validatePrivateKey(key: string): void {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error('Invalid private key');
    }
  },

  // Tron addresses are the same secp256k1-derived 20 bytes as EVM. The derived
  // address is already canonical 20-byte hex, so only the sender side — which
  // arrives in whichever spelling the caller chose — needs normalizing.
  verifyAddressMatchesKey(privateKey: string, address: string): void {
    const key = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    const derived = new ethers.Wallet(key).address;
    assertKeyMatchesSender(derived.toLowerCase() === normalizeAddress(address), address, derived);
  },
};
