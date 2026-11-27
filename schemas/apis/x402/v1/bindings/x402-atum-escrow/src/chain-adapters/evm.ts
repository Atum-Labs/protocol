/**
 * EVM source address/asset helpers. The Permit2 escrow-deposit crypto (build, sign,
 * recover) now lives in the shared `@atum-labs/payment-request-sender-auth` SDK; this
 * adapter only resolves the two chain-form values the SDK does not: the payer's
 * `source.account` and the CAIP-19 (`erc20`) asset identifier.
 */

import type { AuthSigner, ChainAdapter } from './types';

export const evmAdapter: ChainAdapter = {
  async getAddress(signer: AuthSigner): Promise<string> {
    if (!('getAddress' in signer)) {
      throw new Error('evm adapter requires an EIP-712 typed-data signer');
    }
    return signer.getAddress();
  },

  assetIdentifier(network: string, asset: string): string {
    return `${network}/erc20:${asset}`;
  },

  // EVM addresses are already the 0x-hex the witness carries — no conversion needed.
  normalizeRoleAddress(addr: string): string {
    return addr;
  },
};
