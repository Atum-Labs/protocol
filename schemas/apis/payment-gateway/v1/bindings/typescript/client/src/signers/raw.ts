import { localKeySigner } from '@atum-labs/payment-request-sender-auth';
import { getChainAdapter } from '../chain-adapters';
import type { SenderSignInput, SenderSignature, SenderSigner } from './types';

/**
 * Private-key sender signer. A thin wrapper over the shared SDK's
 * {@link localKeySigner}, so raw signing runs the ONE canonical signing path
 * (EVM/Tron secp256k1 typed-data, Solana ed25519) — pgc keeps no signing crypto
 * of its own.
 *
 * The value-free key check runs in the constructor so that constructing this
 * directly can't bypass the guard the factory applies: a malformed key is
 * rejected before any signing library (which could echo the key in an error)
 * sees it. `localKeySigner` performs no such guard.
 */
export class RawSenderSigner implements SenderSigner {
  private readonly inner: SenderSigner;
  readonly network: string;

  constructor(network: string, privateKey: string) {
    this.network = network;
    const adapter = getChainAdapter(network);
    adapter.validatePrivateKey?.(privateKey);
    this.inner = localKeySigner(network, adapter.formatPrivateKey(privateKey));
  }

  sign(signedMessage: SenderSignInput): Promise<SenderSignature> {
    return this.inner.sign(signedMessage);
  }
}
