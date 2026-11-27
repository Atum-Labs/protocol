import type { CommitmentResult } from './commitment-rules.js';

/**
 * Thrown by `recoverAndVerify` when a signed message's `message_prehash` is absent,
 * unparseable, or not a hashable deposit permit, so there is no permit to bind. Detect it with
 * `err instanceof MalformedPrehashError`; `result` carries the commitment outcome it maps to (read
 * it with `commitmentResultOf`). Mirrors the Go `ErrMalformedPrehash` sentinel.
 */
export class MalformedPrehashError extends Error {
  readonly result?: CommitmentResult;
  constructor(message = 'sender_auth: malformed message_prehash', result?: CommitmentResult) {
    super(message);
    this.name = 'MalformedPrehashError';
    this.result = result;
  }
}

/**
 * Thrown by `recoverSigner` when no signer could be derived from the signed message at all:
 * malformed or short hex, a non-canonical (EIP-2 high-s) secp256k1 signature, or a structurally
 * invalid Solana message, signature or pubkey. It is distinct from `SignerMismatchError` so a
 * consumer can tell a signature-format or wallet-compatibility issue from an authentication
 * failure. Mirrors the Go `ErrRecoveryFailed`.
 */
export class RecoveryFailedError extends Error {
  constructor(message = 'sender_auth: could not recover a signer from the signed message') {
    super(message);
    this.name = 'RecoveryFailedError';
  }
}

/**
 * Thrown by `tronNumericChainId` when a caller-supplied Tron chain id cannot be used: it is not an
 * integer in 1..MAX_TRON_CHAIN_ID, the built-in table knows the cluster by another id, or the
 * table gives the id to another cluster. `detail` is the reason, as a commitment check reports it
 * with `verifier_misconfigured`. Mirrors the Go `tronChainIDError`.
 */
export class TronChainIdError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`sender_auth: ${detail}`);
    this.name = 'TronChainIdError';
    this.detail = detail;
  }
}

/**
 * Thrown by `recoverSigner` when a signer was recovered or verified but is not `source.account`.
 * On Solana (ed25519 is not key-recoverable) a wrong key and a bad signature are
 * indistinguishable, so both surface as this. Mirrors the Go `ErrSignerMismatch`.
 */
export class SignerMismatchError extends Error {
  constructor(message = 'sender_auth: recovered signer does not match source.account') {
    super(message);
    this.name = 'SignerMismatchError';
  }
}

/**
 * Thrown by `recoverSigner` and `recoverAndVerify` on Stellar when the signature verifies under
 * `payload.delegate_signer` but that key is not `source.account`. The requester names the signer,
 * and whether it is registered for the depositor is on-chain state no offline check reads, so the
 * payer has not been shown to have consented. It is distinct from `SignerMismatchError` (a bad
 * signature) and `RecoveryFailedError` (malformed input): a consumer that can read the chain may
 * admit the payment after that check. Mirrors the Go `ErrDelegateUnverified`.
 */
export class DelegateUnverifiedError extends Error {
  constructor(
    message = 'sender_auth: the delegate signer is not source.account and is not verified as registered for it',
  ) {
    super(message);
    this.name = 'DelegateUnverifiedError';
  }
}

/**
 * Thrown by `recoverAndVerify` when the permit amount is not the amount the verifier binds it to:
 * `max_source_amount`, or `quoteSourceAmount` when that is set. Mirrors the Go
 * `ErrPermitAmountMismatch`.
 */
export class PermitAmountMismatchError extends Error {
  constructor(boundTo: 'max_source_amount' | 'the quote source_amount') {
    super(`sender_auth: permit amount does not match ${boundTo}`);
    this.name = 'PermitAmountMismatchError';
  }
}
