import nacl from 'tweetnacl';
import { Pubkey } from '@atum-labs/stellar-escrow-encoding';
import type { ChainAdapter } from './types';
import { assertKeyMatchesSender } from './types';

/**
 * Stellar. The payer authorizes each deposit offchain: an ed25519 signature by its delegate signer
 * over the escrow's deposit digest, built by the shared sender_auth SDK. The key handled here is
 * that delegate signer's, a 32-byte ed25519 seed as 64 hex digits. Stellar's own `S...` secret
 * strkey is not accepted, so a secret never passes through a string this package parses.
 *
 * `turnkeyAddressFormat` is deliberately absent (SEAM(turnkey-stellar), see signers/stellar-turnkey.ts): Turnkey's Stellar address format is unconfirmed,
 * and a guessed value here would make `resolveTurnkeyAddresses` claim accounts it
 * has not verified.
 */
export const stellarAdapter: ChainAdapter = {
  formatPrivateKey(key: string): string {
    return key.startsWith('0x') ? key.slice(2) : key;
  },

  // Value-free: never interpolate the key.
  validatePrivateKey(key: string): void {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error('Invalid private key');
    }
  },

  // Pinning the sender asserts the key IS the depositor's own: the delegate signer is then the
  // depositor's key. A depositor whose delegate is a different key (or a contract account, which
  // has no key of its own) omits `pinnedAddress`, since the registration of the delegate is on-chain
  // state that no offline check reads; `send-payment` does so with `--delegate-signer`.
  verifyAddressMatchesKey(privateKey: string, address: string): void {
    const derived = deriveStellarAddress(privateKey);
    assertKeyMatchesSender(derived === address, address, derived);
  },
};

/** The G strkey of the ed25519 key a hex seed derives. */
function deriveStellarAddress(privateKey: string): string {
  const hex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  const keys = nacl.sign.keyPair.fromSeed(Uint8Array.from(Buffer.from(hex, 'hex')));
  return Pubkey.fromBytes(keys.publicKey).toString();
}
