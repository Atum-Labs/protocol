import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { ChainAdapter } from './types';
import { assertKeyMatchesSender } from './types';

export const solanaAdapter: ChainAdapter = {
  turnkeyAddressFormat: 'ADDRESS_FORMAT_SOLANA',

  formatPrivateKey(key: string): string {
    return key.startsWith('0x') ? key.slice(2) : key;
  },

  verifyAddressMatchesKey(privateKey: string, address: string): void {
    const derived = deriveSolanaAddress(privateKey);
    assertKeyMatchesSender(derived === address, address, derived);
  },
};

/** base58 Ed25519 public key derived from the private key (the Solana address). */
function deriveSolanaAddress(privateKey: string): string {
  return bs58.encode(nacl.sign.keyPair.fromSecretKey(secretKeyFromPrivate(privateKey)).publicKey);
}

/**
 * Resolve a 64-byte Ed25519 secret key from the supported private-key encodings:
 *   - 64-char hex string: a 32-byte seed
 *   - base58 32 bytes: a seed
 *   - base58 64 bytes: a full secret key
 */
function secretKeyFromPrivate(privateKey: string): Uint8Array {
  if (/^[0-9a-fA-F]{64}$/.test(privateKey)) {
    // Hex-encoded 32-byte seed
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      seed[i] = parseInt(privateKey.substring(i * 2, i * 2 + 2), 16);
    }
    return nacl.sign.keyPair.fromSeed(seed).secretKey;
  }

  // Base58-encoded key (32-byte seed or 64-byte full keypair)
  const decoded = bs58.decode(privateKey);
  if (decoded.length === 64) {
    return decoded;
  }
  if (decoded.length === 32) {
    return nacl.sign.keyPair.fromSeed(decoded).secretKey;
  }
  throw new Error(
    `Invalid Solana private key length: expected 32 or 64 bytes, got ${decoded.length}`,
  );
}
