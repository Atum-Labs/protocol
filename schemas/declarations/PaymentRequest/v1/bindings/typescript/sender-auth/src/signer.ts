import type { SignedMessageInput } from './types.js';
import { getChainAdapter } from './adapters/index.js';

/** Result of signing one sender_auth message. */
export interface SenderSignature {
  /** 0x-prefixed signature hex (65-byte secp256k1 for EVM/Tron, 64-byte ed25519 for Solana). */
  signature: string;
  /**
   * base58 signer public key for non-recoverable schemes (Solana), attached to the signed
   * message's `payload.delegate_signer`. Absent for EVM/Tron (recoverable secp256k1).
   */
  delegateSigner?: string;
}

/**
 * The signer plug-in point. A `SenderSigner` produces the signature (and, for Solana, the
 * delegate public key) for one sender_auth message. This is the ONLY signing surface the SDK
 * defines: it holds no key material and knows nothing about any wallet provider.
 *
 * Remote/opaque providers (Turnkey, Fireblocks, Utila, HSM/KMS/MPC) implement this interface
 * OUTSIDE the SDK and are injected by the consumer. The SDK ships exactly one built-in
 * implementation — {@link localKeySigner} — for raw local private keys.
 */
export interface SenderSigner {
  /**
   * The CAIP-2 network the signer's key is for, when the signer is bound to one. {@link localKeySigner}
   * sets it, so an entry point that holds the request can refuse a request whose source is another
   * chain than the key's (a Stellar key signs 32 bytes as a transaction signature too, so it must not
   * be handed a message the request calls an EVM permit). Absent on a signer that is not bound.
   */
  readonly network?: string;
  sign(signedMessage: SignedMessageInput): Promise<SenderSignature>;
}

/**
 * The SDK's only built-in signer: a raw local private key for the given CAIP-2 network. Uses
 * the chain adapter's own signing primitive (secp256k1 typed-data for EVM/Tron, ed25519 for
 * Solana) and attaches the delegate public key on chains whose signatures are not recoverable.
 *
 * Remote signers do NOT belong here — implement {@link SenderSigner} in the provider's own
 * package and inject it.
 */
export function localKeySigner(network: string, privateKey: string): SenderSigner {
  const adapter = getChainAdapter(network);
  return {
    network,
    async sign(signedMessage: SignedMessageInput): Promise<SenderSignature> {
      const signature = await adapter.sign(signedMessage, privateKey);
      const delegateSigner = adapter.deriveDelegateSigner?.(privateKey);
      return delegateSigner !== undefined ? { signature, delegateSigner } : { signature };
    },
  };
}
