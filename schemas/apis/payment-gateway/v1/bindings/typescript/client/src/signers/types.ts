import type { SignedMessage } from '../generated/types.gen';
import type { Logger, Meter } from '@atum-labs/turnkey-signer';

// NOTE: this interface is structurally the shared sender-auth SDK's `SenderSigner`
// (`@atum-labs/payment-request-sender-auth`), and the raw path is backed by the
// SDK's `localKeySigner` — so there is ONE signing implementation. It is redeclared
// here (rather than re-exported from the SDK) on purpose: pgc ships a self-contained
// bundle with no surviving `@atum-labs/*` reference in its `.d.ts`, and re-exporting
// the SDK type would drag `@atum-labs/schema-declarations` into pgc's type bundle.
// Structural typing makes the two interchangeable.

/** Result of signing a sender_auth message. */
export interface SenderSignature {
  /** 0x-prefixed signature hex (65-byte secp256k1 for EVM/Tron, 64-byte ed25519 for Solana). */
  signature: string;
  /**
   * base58 signer public key for non-recoverable schemes (Solana), attached to
   * the signed message's payload.delegate_signer. Absent for EVM/Tron, whose
   * secp256k1 signatures are recoverable.
   */
  delegateSigner?: string;
}

/**
 * What a {@link SenderSigner} signs: one signed message, plus `svmMessageScheme`, which is
 * SDK-local and never sent. On Solana it names the escrow's message scheme: absent or `''` signs the
 * 32-byte hash itself, the default; `'escrow-text-v1'` signs the escrow text over it (the reserve
 * text for a reserve record). Other chains ignore it.
 */
export type SenderSignInput = SignedMessage & { svmMessageScheme?: string };

/** Signs a single sender_auth signed message for a payment request. */
export interface SenderSigner {
  /**
   * The CAIP-2 network the signer's key is for, when it is bound to one (the private-key signer is).
   * `signPaymentRequest` refuses a request whose source is another network than a bound signer's.
   */
  readonly network?: string;
  sign(signedMessage: SenderSignInput): Promise<SenderSignature>;
}

/** Turnkey provider configuration (shared by the SDK and the CLI env loader). */
export interface TurnkeyConfig {
  organizationId: string;
  walletId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  /**
   * Chain-native address the signer is expected to resolve to. Verified against
   * the address Turnkey returns at initialize(); a mismatch fails fast rather
   * than signing as the wrong depositor. Omit it to skip the check; an empty
   * value is rejected rather than treated as omitted.
   */
  pinnedAddress?: string;
  /**
   * Optional observability threaded to the Turnkey network path (default noop).
   * SDK consumers can wire their own logger and meter; the CLI leaves them unset.
   */
  logger?: Logger;
  meter?: Meter;
}

/**
 * Options selecting a sender-signing provider. Defaults to the private-key provider.
 * `pinnedAddress` behaves the same on both: omitted skips the sender check, empty is rejected.
 */
export type SenderSignerOptions =
  | { provider?: 'raw'; privateKey: string; pinnedAddress?: string }
  | ({ provider: 'turnkey' } & TurnkeyConfig);
