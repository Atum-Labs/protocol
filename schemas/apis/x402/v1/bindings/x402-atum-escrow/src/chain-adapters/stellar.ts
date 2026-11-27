/**
 * Stellar source address/asset helpers. The Ed25519 escrow-deposit authorization is built and
 * verified by the shared `@atum-labs/payment-request-sender-auth` SDK; this adapter only
 * resolves the two chain-form values the SDK does not: the payer's `source.account` (the
 * signer's `G…` account strkey) and the CAIP-19 (`sep41`) asset identifier.
 */

import { asEd25519Signer, type AuthSigner, type ChainAdapter } from './types';

/** A Stellar account (`G…`) or contract (`C…`) strkey: 56 characters of RFC 4648 base32. */
const ACCOUNT = /^G[A-Z2-7]{55}$/;
const CONTRACT = /^C[A-Z2-7]{55}$/;

export const stellarAdapter: ChainAdapter = {
  async getAddress(signer: AuthSigner): Promise<string> {
    const account = asEd25519Signer(signer, 'stellar', 'StellarSigner').publicKey;
    // Muxed (`M…`) addresses and contract (`C…`) ids cannot sign a deposit, and a payer account
    // in any other form would never match the key the facilitator verifies against.
    if (!ACCOUNT.test(account)) {
      throw new Error("stellar adapter: the signer's publicKey must be a G… account strkey");
    }
    return account;
  },

  assetIdentifier(network: string, asset: string): string {
    // A Stellar token is a SEP-41 contract, named by its `C…` contract id. A classic asset
    // (`CODE:ISSUER`) or an account strkey is not one, so refuse it rather than sign a deposit
    // for a token the escrow cannot pull. The id is case-sensitive; it is carried verbatim.
    if (!CONTRACT.test(asset)) {
      throw new Error(
        `stellar adapter: a SEP-41 token must be a C… contract strkey, got '${asset}'`,
      );
    }
    return `${network}/sep41:${asset}`;
  },

  // Strkeys are the form in both the signed witness (decoded to bytes by the encoder) and the
  // request body — no conversion.
  normalizeRoleAddress(addr: string): string {
    return addr;
  },
};
