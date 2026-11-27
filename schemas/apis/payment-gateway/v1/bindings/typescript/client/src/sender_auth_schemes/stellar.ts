/**
 * Stellar deposit helpers: replay nonces and the escrow's bounds.
 *
 * Deposit authorizations are built through the shared sender_auth adapter
 * (`getChainAdapter('stellar:...').buildAuthMessage(...)`), which commits the destination, reads the
 * network id from the source chain and the escrow from the defaults, and hashes with the shared
 * escrow encoder. For the raw primitive, use `computeDepositHash` from
 * @atum-labs/stellar-escrow-encoding (contracts/stellar/bindings/typescript/escrow-encoding), the
 * encoding shared with the on-chain contract and the Go signing library.
 *
 * What this module does not do: the payer's one-time setup. The delegate signer is registered by the
 * depositor's own `create_delegate` call and the escrow's SEP-41 allowance by its own `approve`, both
 * signed by the depositor's Stellar account, and neither is a sender_auth message. See
 * contracts/stellar/source/docs/witness-layouts.md ("Who signs what").
 */

import { deterministicStellarNonce } from '@atum-labs/payment-request-sender-auth';
import { MAX_DEPOSIT_VALIDITY_SECS } from '@atum-labs/stellar-escrow-encoding';

export { deterministicStellarNonce };

/** The longest a Stellar deposit stays acceptable, in seconds: the escrow's bound on deadline - issued_at. */
export const STELLAR_MAX_DEPOSIT_VALIDITY_SECS = Number(MAX_DEPOSIT_VALIDITY_SECS);

/**
 * A random unsigned 64-bit deposit nonce. The escrow keeps an unordered per-depositor bitmap and
 * never reuses a nonce, so any u64 is valid; prefer {@link deterministicStellarNonce}, which a
 * retry reproduces.
 */
export function generateStellarNonce(): bigint {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).readBigUInt64BE();
}
