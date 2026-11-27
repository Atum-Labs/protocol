import { MESSAGE_SCHEMES } from '@atum-labs/solana-escrow-encoding';
import type { ChainDefaults } from './chain-adapters';

/** How a signer signs for one escrow on a Solana source chain. */
export interface EscrowSigning {
  /** The escrow's signature domain version, which its deposit and reserve hashes commit to. */
  svmSignatureDomainVersion?: number;
  /**
   * The escrow's svm message scheme: `''` signs the 32-byte hash itself (every escrow the gateway
   * named before `escrows`), `'escrow-text-v1'` the escrow text.
   */
  svmMessageScheme: string;
}

/**
 * How a signer signs for `escrowContract` on the chain `defaults` describe: the matching
 * `defaults.escrows` entry's domain version and message scheme, or the chain's own domain version
 * and the raw hash when the escrow is not listed (a gateway that predates `escrows`). Throws on a
 * message scheme this client does not know, since a signature in the wrong form never lands.
 */
export function escrowSigningOf(defaults: ChainDefaults, escrowContract: string): EscrowSigning {
  const entry = defaults.escrows?.find((e) => e.escrowContract === escrowContract);
  const svmMessageScheme = entry?.svmMessage ?? '';
  if (!MESSAGE_SCHEMES.includes(svmMessageScheme)) {
    throw new Error(
      `payment-gateway-client: escrow ${escrowContract} signs with svm_message ${JSON.stringify(svmMessageScheme)}, which this client does not know: upgrade it`,
    );
  }
  return {
    svmSignatureDomainVersion:
      entry?.svmSignatureDomainVersion ?? defaults.svmSignatureDomainVersion,
    svmMessageScheme,
  };
}
