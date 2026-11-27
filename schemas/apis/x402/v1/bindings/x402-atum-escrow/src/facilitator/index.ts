/**
 * atum-escrow facilitator mechanism — the gateway side.
 *
 * Implements the x402 SchemeNetworkFacilitator for the `atum-escrow` scheme. Unlike
 * the stock `exact` facilitator (which holds a signer and settles on-chain itself),
 * this one is KEYLESS: `verify` validates the request locally, apart from looking up the
 * corridor it trusts, and `settle` relays it to the Atum network, which executes the
 * escrow/fulfillment permissionlessly.
 *
 * The gateway is injected as a minimal {@link PaymentSubmitter}, so the mechanism has no
 * gateway SDK or chain dependency; the host adapts its gateway client into that shape.
 */

import type {
  SchemeNetworkFacilitator,
  Network,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  FacilitatorContext,
} from '@x402/core/types';
import {
  assertAtumEscrowExtra,
  assertAtumEscrowPayload,
  type AtumEscrowExtra,
  type PaymentRequest,
} from '../contract';
import { getChainAdapter } from '../chain-adapters';
import { atumEscrowRequestId, requireAtumResource } from '../request-id';
import { resolvePaymentIdentifier } from '../payment-identifier';
import { caipEqual } from '../internal';
import {
  AtumEscrowTrustError,
  atumGatewayTrust,
  type TrustResolver,
  type TrustedRoles,
} from '../client/trust';
// Source-side recovery and term binding are delegated to the shared sender_auth library,
// which has a Go implementation of the same rules. The local chain adapters are used for
// asset-identifier reconstruction below.
import {
  commitmentLogFields,
  commitmentResultOf,
  depositRequestHashShadowOf,
  getChainAdapter as recoverSourceAuth,
  readDepositRequest,
  REPLAY_HORIZON_SECS,
  verifyRequestCommitment,
  type CommitmentExpectation,
  type CommitmentOptions,
  type CommitmentResult,
  type DepositRequestHashShadow,
  type SignedMessageInput as SenderAuthMessage,
  type SolanaDomain,
  type VerifiedSenderAuth,
  type VerifyExpectations,
} from '@atum-labs/payment-request-sender-auth';

export type {
  CommitmentResult,
  CommitmentOutcome,
  DepositRequestHashShadow,
} from '@atum-labs/payment-request-sender-auth';

/**
 * The PaymentRequest the facilitator reads, from the generated declaration. `max_source_amount`
 * and `sender_auth` are narrowed to required because `paymentRequestOf` guarantees them.
 */
type PaymentRequestView = PaymentRequest &
  Required<Pick<PaymentRequest, 'max_source_amount' | 'sender_auth'>>;

/**
 * How far a submitted payment has got, as the gateway reports it. Mirrors the
 * `status` field of the gateway's payment API.
 *
 * A pending payment is waited on and re-submitted only under the SAME idempotency key; a failed
 * one keeps resolving to the same payment, so a new attempt needs a NEW key. `finalizing` means
 * the payout is on chain but not yet final; whether that counts as settled is
 * {@link AtumEscrowFacilitatorConfig.settleAt}. `refunding` and `refund_available` are treated as
 * pending: on `refund_available` the funds are still in escrow until someone submits the refund
 * signature, and a late delivery can still complete it. `refunded` is terminal like `failed`.
 *
 * @public
 */
export type PaymentSettlementStatus =
  'pending' | 'finalizing' | 'completed' | 'failed' | 'refunding' | 'refund_available' | 'refunded';

/**
 * The payment status at which `settle` reports success: `finalizing` (the payout is on chain,
 * not yet final) or `completed` (final).
 *
 * @public
 */
export type SettleAt = 'finalizing' | 'completed';

/**
 * One on-chain transaction of a payment, as the gateway reports it under `transactions`.
 *
 * @public
 */
export interface PaymentTransactionView {
  transaction_hash: string;
  /** CAIP-2 id of the chain the transaction is on. */
  chain_id: string;
  block_number?: number;
}

/**
 * The transactions a payment has produced so far: the payer's deposit on the source chain and
 * the payout to the recipient on the destination chain.
 *
 * @public
 */
export interface PaymentTransactionsView {
  deposit?: PaymentTransactionView;
  fulfillment?: PaymentTransactionView;
}

/**
 * The gateway's response to a submitted payment: a `payment_id`, the payment's current
 * `status`, and its `transactions` so far.
 *
 * @public
 */
export interface PaymentSubmitResult {
  payment_id?: string;
  /**
   * Where the payment stands. When absent, the payment is pending, so a live payment is never
   * reported as failed.
   */
  status?: PaymentSettlementStatus;
  /**
   * The gateway's `transactions`, passed through as received (`undefined` when the response has
   * none). Required so an adapter cannot drop it by omission: the payout is read from
   * `fulfillment`, and without it a payment is never answered before `completed`.
   */
  transactions: PaymentTransactionsView | undefined;
}

/**
 * Minimal gateway surface the facilitator needs. Structurally satisfied by an
 * adapter over `@atumlabs/payment-gateway-client`; declared locally so the
 * mechanism has no SDK import or runtime dependency.
 *
 * @public
 */
export interface PaymentSubmitter {
  /**
   * Submit a signed Atum PaymentRequest to the network; resolves with the gateway's response.
   *
   * Throw {@link PaymentRejectedError} when the gateway refuses the payment for a reason the
   * caller can act on — anything else is treated as an infrastructure fault.
   */
  submit(request: unknown, context?: PaymentSubmitContext): Promise<PaymentSubmitResult>;
}

/**
 * What the facilitator hands a {@link PaymentSubmitter} with the request it submits.
 *
 * @public
 */
export interface PaymentSubmitContext {
  /**
   * Who built the request (`x402`) and its depositRequestHash v2 as submitted. Forward it as the
   * `X-Atum-Producer` and `X-Atum-Deposit-Request-Hash-V2` headers: with the gateway client, spread
   * `submitPaymentShadow(context.shadow)` into `submitPayment`. Used for compatibility diagnostics
   * only; it never changes how the payment is processed.
   */
  shadow: DepositRequestHashShadow;
}

/**
 * Thrown by a {@link PaymentSubmitter} when the gateway refuses the payment on the caller's
 * account rather than failing internally, for example a reused idempotency key carrying different
 * payment terms. The facilitator surfaces it as the settle response's reason instead of an
 * internal error.
 *
 * @public
 */
export class PaymentRejectedError extends Error {
  /**
   * Discriminant for {@link isPaymentRejectedError}. The mechanism and the adapter that throws
   * may be bundled separately, and two copies of a class make `instanceof` false.
   */
  readonly isPaymentRejected = true as const;

  /**
   * @param code - the gateway's machine-readable reason, surfaced verbatim as the settle
   *   response's `errorReason` so the caller sees what it can actually fix
   * @param message - human-readable detail
   */
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentRejectedError';
  }
}

/** Type guard for {@link PaymentRejectedError}, safe across duplicated module instances. */
export function isPaymentRejectedError(err: unknown): err is PaymentRejectedError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { isPaymentRejected?: unknown }).isPaymentRejected === true
  );
}

/**
 * Configuration for {@link AtumEscrowFacilitatorScheme}.
 *
 * @public
 */
export interface AtumEscrowFacilitatorConfig {
  /** The Atum-network gateway the `settle` path relays to. */
  submitter: PaymentSubmitter;
  /**
   * Wall-clock source, in epoch milliseconds, for the deadline-ordering check in
   * `verify`. Injectable for deterministic tests; defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Builds the URL where an unfinished payment can be checked, published on the settle
   * response. The host supplies it because the mechanism does not know the gateway's REST shape.
   * Returning `undefined`, or omitting this, publishes the payment id without a URL; do that when
   * the gateway address is not reachable by the response's reader.
   */
  statusUrlFor?: (paymentId: string) => string | undefined;
  /**
   * Called with the result of the payee check for every payment that reaches it, admissions and
   * refusals alike, so you can count payments by `logFields.sender_auth_result` and log each
   * refusal with all of `logFields`. `settle` verifies again, so it reports again. An exception
   * from this callback on an admission refuses the payment with a fixed reason.
   */
  onCommitmentResult?: (result: CommitmentResult, logFields: Record<string, string>) => void;
  /**
   * Which escrow, reserver and fulfillment proxy this facilitator vouches for on a chain. A
   * payment naming any other is refused, because the network behind this facilitator would not
   * settle it. The releaser is not compared: which verifier to rely on is the settler's choice.
   *
   * @remarks
   * Optional. Without it, the facilitator asks Atum's production gateways, as the client does
   * (see `atumGatewayTrust`). Pass a resolver for the deployment this facilitator relays to, or a
   * fixed one to verify without network calls.
   */
  trust?: TrustResolver;
  /**
   * How the payee check reads depositRequestHash v2. A deposit committing v2 is accepted only when the
   * requirement lists 2 in `extra.atum.depositRequestHashVersions`. `audit`, the default, and
   * `enforce` also accept one committing v1. `audit` admits a request the strict reader refuses, by
   * the v1 reading, and reports why in `CommitmentResult.strictDetail`; `enforce` refuses it as
   * `request_malformed`. `retire` is `enforce` that accepts only v2: a deposit committing v1 is
   * refused as `request_hash_mismatch`, and a requirement that does not list 2, which no payer could
   * then pay, is refused with a reason that says so. Set `retire` once every requirement you serve
   * lists 2 and your payers sign v2. The empty string (or null, from untyped configuration) is off:
   * only v1 is read, as before v2. Any other value is refused at construction.
   */
  depositRequestHashV2Mode?: CommitmentOptions['depositRequestHashV2Mode'] | '';
  /**
   * The payment status at which `settle` reports success. `finalizing`, the default, serves the
   * resource as soon as the payout is on chain, with its transaction hash; a chain reorganization
   * could still drop that transaction, and serving then is accepting that risk. `completed`
   * waits for finality, minutes on some chains, and reports {@link SETTLEMENT_PENDING} until
   * then.
   */
  settleAt?: SettleAt;
}

/**
 * `invalidReason` on a verify response (and so `errorReason` on settle) whose payment's earliest
 * deadline — the signed authorization's or the quote's — passed while the facilitator was
 * consulting its trust source. The payment was live when its terms were checked; it no longer
 * is, so it must be re-signed rather than retried.
 *
 * @public
 */
export const PAYMENT_EXPIRED = 'payment_expired';

/**
 * `errorReason` on a settle response whose payment was accepted by the network but has not
 * finished settling. It is not a failure: the payment exists, carries the `paymentId` in
 * `extensions.atum`, and must be waited on rather than re-paid. A retry is safe **only** with
 * the same idempotency key, which resolves to this same payment.
 *
 * @public
 */
export const SETTLEMENT_PENDING = 'settlement_pending';

/**
 * `errorReason` on a settle response whose payment reached a terminal failure. Distinct from
 * {@link SETTLEMENT_PENDING} because it demands the opposite of the caller: re-submitting under
 * the SAME idempotency key resolves to the same failed payment, so a new attempt needs a NEW key.
 *
 * @public
 */
export const SETTLEMENT_FAILED = 'settlement_failed';

/**
 * `errorReason` when the gateway identified no payment at all — neither a receipt nor an id.
 * Nothing was accepted, so there is nothing to wait on and nothing to correlate.
 *
 * @public
 */
export const SETTLEMENT_NOT_ACCEPTED = 'settlement_not_accepted';

/**
 * The gateway side of the `atum-escrow` x402 scheme. Register one instance into an
 * `x402Facilitator`; it verifies requests locally, against the corridor its trust source
 * vouches for, and relays settlement to Atum.
 *
 * @public
 */
export class AtumEscrowFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = 'atum-escrow';
  // One instance serves eip155, solana, stellar and tron. @x402/core uses caipFamily only to group
  // signers in /supported, and this facilitator has none; advertised networks come from the
  // registered-networks list.
  readonly caipFamily = '*';

  private readonly submitter: PaymentSubmitter;
  private readonly trust: TrustResolver;
  private readonly now: () => number;
  private readonly statusUrlFor?: (paymentId: string) => string | undefined;
  private readonly onCommitmentResult?: (
    result: CommitmentResult,
    logFields: Record<string, string>,
  ) => void;
  /** Undefined is off: only v1 is read, as before v2. */
  private readonly depositRequestHashV2Mode: CommitmentOptions['depositRequestHashV2Mode'];
  private readonly settleAt: SettleAt;

  constructor(config: AtumEscrowFacilitatorConfig) {
    const settleAt = config.settleAt ?? 'finalizing';
    if (settleAt !== 'finalizing' && settleAt !== 'completed') {
      throw new Error(
        `atum-escrow: settleAt must be 'finalizing' or 'completed', not ${JSON.stringify(settleAt)}`,
      );
    }
    this.settleAt = settleAt;
    // Absent is audit. The empty string and null are off, as the shared SDK and Go read them, so a
    // mode read from shared configuration means the same here.
    const configured: unknown = config.depositRequestHashV2Mode;
    const mode = configured === undefined ? 'audit' : configured;
    if (mode === '' || mode === null) {
      this.depositRequestHashV2Mode = undefined;
    } else if (mode === 'audit' || mode === 'enforce' || mode === 'retire') {
      this.depositRequestHashV2Mode = mode;
    } else {
      throw new Error(
        `atum-escrow: depositRequestHashV2Mode must be 'audit', 'enforce', 'retire' or '' (off), not ${JSON.stringify(mode)}`,
      );
    }
    this.submitter = config.submitter;
    this.now = config.now ?? (() => Date.now());
    this.statusUrlFor = config.statusUrlFor;
    this.onCommitmentResult = config.onCommitmentResult;
    this.trust = config.trust ?? atumGatewayTrust();
  }

  /**
   * Reports a payee-check refusal carried by `err`, if it carries one; the refusal stands. In audit
   * mode a strict reader refusal of the same request is reported with it as `strictDetail`.
   */
  private reportRefusal(err: unknown, strictDetail = ''): void {
    const carried = commitmentResultOf(err);
    if (carried === undefined) return;
    const refused =
      strictDetail !== '' && this.depositRequestHashV2Mode === 'audit'
        ? { ...carried, strictDetail }
        : carried;
    try {
      this.onCommitmentResult?.(refused, commitmentLogFields(refused));
    } catch {
      // The refusal stands whatever the callback does.
    }
  }

  /**
   * The reason a requirement's corridor is not one this facilitator vouches for, or `undefined`
   * when it is. Escrow, `payTo` and reserver are compared on the source chain; the fulfillment
   * proxy on the destination chain, where it runs.
   */
  private async untrustedCorridor(
    requirements: PaymentRequirements,
    atum: AtumEscrowExtra,
  ): Promise<string | undefined> {
    const source = requirements.network;
    const destination = atum.destination.network;
    const [onSource, onDestination] = await Promise.all([
      this.trustFor(source),
      destination === source ? undefined : this.trustFor(destination),
    ]);
    if (typeof onSource === 'string') return onSource;
    if (typeof onDestination === 'string') return onDestination;
    const destinationRoles = onDestination ?? onSource;

    const checks: Array<[string, string, string, string]> = [
      ['extra.atum.escrow', source, onSource.escrowContract, atum.escrow],
      ['payTo', source, onSource.escrowContract, requirements.payTo],
      ['extra.atum.reserver', source, onSource.quoteSelector, atum.reserver],
      [
        'extra.atum.fulfillmentProxy',
        destination,
        destinationRoles.fulfillmentProxy,
        atum.fulfillmentProxy,
      ],
    ];
    for (const [field, network, trusted, named] of checks) {
      if (!caipEqual(network, trusted, named)) {
        return `${field} is not trusted by this facilitator on ${network}`;
      }
    }
    return undefined;
  }

  /** The trusted roles on a chain, or the refusal reason when they cannot be had. */
  private async trustFor(network: string): Promise<TrustedRoles | string> {
    try {
      return await this.trust(network);
    } catch (err) {
      if (err instanceof AtumEscrowTrustError && err.code === 'CHAIN_NOT_TRUSTED') {
        return `${network} is not served by this facilitator's trust source`;
      }
      return `trust source unavailable for ${network}`;
    }
  }

  /** No settlement signer: Atum's settlers execute the escrow operations permissionlessly. */
  getSigners(_network: string): string[] {
    return [];
  }

  /** No mechanism-specific `/supported` extra at this layer (the host injects token lists). */
  getExtra(_network: Network): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * Validate a request before it is relayed to Atum. Everything is checked locally except the
   * corridor, which the trust source is asked about (cached once it answers; failures are not
   * cached).
   *
   * @remarks
   * The deposit is verified for the requirement's chain, and the payload must declare the scheme
   * this facilitator verifies there. The request must then read the same to every reader where it
   * is read, and its signed deposit must pay the request's own destination and request id.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    try {
      const atum = requireAtumExtra(requirements);
      if (this.depositRequestHashV2Mode === 'retire' && !acceptsV2(atum)) {
        return invalid(RETIRED_REQUIREMENT_WITHOUT_V2);
      }
      const pr = paymentRequestOf(payload);
      requirePaymentAnchoredToItsIdentifier(pr, payload, requirements);
      const scheme = SCHEME_BY_NAMESPACE.get(requirements.network.split(':')[0] ?? '');
      if (scheme === undefined) return invalid(`unsupported network: ${requirements.network}`);
      if (pr.sender_auth.message_scheme !== scheme) {
        return invalid(
          `unsupported message_scheme for ${requirements.network}: ${pr.sender_auth.message_scheme}`,
        );
      }
      const verdict = this.verifySource(scheme, pr, requirements, atum);
      if ('refused' in verdict) return verdict.refused;
      // Judged only once the signature has bound the payer, so a bad signature is reported as
      // one rather than as a corridor the payer never actually authorized.
      const untrusted = await this.untrustedCorridor(requirements, atum);
      if (untrusted !== undefined) return invalid(untrusted);
      // The lookup above is network I/O, so the deadlines checked before it can have passed
      // while it ran; the clock is read again before the payment is vouched for.
      if (this.now() >= verdict.expiresAtMs) return invalid(PAYMENT_EXPIRED);
      // The object checked here is the object settle relays.
      const commitment = verifyRequestCommitment(JSON.stringify(pr), solanaDomainOf(atum), {
        depositRequestHashV2Mode: this.depositRequestHashV2Mode,
        // The escrow the requirement names, which `untrustedCorridor` has just checked against the
        // trust source, so it is this facilitator's own configuration and never the payment's. The
        // shared library refuses a Stellar payment without it.
        ...(scheme === 'STELLAR' ? { stellarEscrow: atum.escrow } : {}),
      });
      try {
        this.onCommitmentResult?.(commitment, commitmentLogFields(commitment));
      } catch {
        // The callback's own error is not the payer's to see.
        return invalid('atum-escrow: the payment could not be recorded, so it is refused');
      }
      return { isValid: true, payer: verdict.payer };
    } catch (err) {
      this.reportRefusal(err);
      return { isValid: false, invalidReason: (err as Error).message };
    }
  }

  /**
   * Verify an EVM Permit2 escrow-deposit authorization.
   *
   * @remarks
   * The escrow-deposit signature is re-verified against the *canonical* Permit2
   * domain/types (rebuilt via the encoder) over the payload's message — the
   * client-supplied `message_prehash.domain` is never trusted — and must recover to
   * `source.account`. The signed terms and the request are then checked against the
   * requirement: escrow spender, source token, witness roles, `max_source_amount ≤`
   * the cap, receive-side destination/amount, and the deadline ordering.
   */
  private verifyEvmPermit2(
    pr: PaymentRequestView,
    requirements: PaymentRequirements,
    atum: AtumEscrowExtra,
  ): SourceVerdict {
    // Binds the signed terms to the requirement's own asset, escrow and roles, not the
    // payload's self-reported values, so the payment is bound to the offered corridor.
    const commitment = commitmentOf(pr, this.depositRequestHashV2Mode, acceptsV2(atum));
    let verified;
    try {
      verified = recoverSourceAuth(requirements.network).recoverAndVerify(
        pr.sender_auth.signed_messages[0] as SenderAuthMessage,
        {
          network: requirements.network,
          asset: requirements.asset,
          account: pr.source.account,
        },
        commitment.expectation,
        {
          maxSourceAmount: pr.max_source_amount,
          escrowContract: atum.escrow,
          reserver: atum.reserver,
          releaser: atum.releaser,
          nowSec: Math.floor(this.now() / 1000),
        },
      );
    } catch (err) {
      this.reportRefusal(err, commitment.strictDetail);
      return { refused: invalid((err as Error).message) };
    }

    // Amount cap, receive side, routing fields and deadlines.
    return accepted(pr, requirements, atum, this.now(), verified.deadlineSec);
  }

  /** The source-chain arm for the scheme the requirement's network pairs with. */
  private verifySource(
    scheme: string,
    pr: PaymentRequestView,
    requirements: PaymentRequirements,
    atum: AtumEscrowExtra,
  ): SourceVerdict {
    switch (scheme) {
      case 'SOLANA':
        return this.verifySolana(pr, requirements, atum);
      case 'STELLAR':
        return this.verifyStellar(pr, requirements, atum);
      default:
        return this.verifyEvmPermit2(pr, requirements, atum);
    }
  }

  /**
   * Verify a Solana Ed25519 escrow-deposit authorization.
   *
   * @remarks
   * Ed25519 is not public-key recoverable, so the deposit signature is verified against
   * the payload-disclosed `delegate_signer` (via the source-chain adapter, which rebuilds
   * the domain-separated digest from the prehash and the requirement's escrow domain and
   * throws on a mismatch), and that key must equal `source.account`. The signed source
   * terms and the request are then checked as policy. No escrow-address check is needed:
   * the escrow program id is bound inside the signed domain, so a wrong program changes
   * the digest and fails the recovery above.
   */
  private verifySolana(
    pr: PaymentRequestView,
    requirements: PaymentRequirements,
    atum: AtumEscrowExtra,
  ): SourceVerdict {
    const recovered = this.recoverEd25519(pr, requirements, atum, {
      svmSignatureClusterId: atum.svmSignatureClusterId,
      svmSignatureDomainVersion: atum.svmSignatureDomainVersion,
    });
    if ('refused' in recovered) return recovered;

    // Freshness: the escrow accepts a Solana deposit only within its replay window, so refuse an
    // authorization that has expired or whose issued_at is in the future before it is relayed.
    const stale = staleDeadline(
      recovered.verified.deadlineSec,
      Math.floor(this.now() / 1000),
      'Solana',
      REPLAY_HORIZON_SECS,
      'issued_at is in the future, beyond the replay window',
    );
    if (stale !== undefined) return { refused: stale };

    // Amount cap, receive side, routing fields and deadlines.
    return accepted(pr, requirements, atum, this.now(), recovered.verified.deadlineSec);
  }

  /**
   * Verify a Stellar Ed25519 escrow-deposit authorization.
   *
   * @remarks
   * As on Solana, Ed25519 is not public-key recoverable: the deposit signature is verified
   * against the payload-disclosed `delegate_signer`, and the escrow contract is bound inside the
   * signed digest, so a wrong contract fails the recovery. The shared library also refuses a
   * delegate that is not `source.account` (a separate delegate's registration is on-chain state
   * only the escrow can confirm), as the {@link StellarSigner} the client signs with is the
   * account itself. Without that, anyone could present any account as the payer under a key of
   * their own, and the facilitator would vouch for it; the escrow would refuse the deposit on
   * chain, but only after settle had relayed it, so the refusal here comes from the library's
   * `recoverAndVerify` and this arm adds no check of its own.
   * The escrow accepts a deposit only while `issued_at` is not ahead of the ledger and its
   * deadline lies at most a day after `issued_at`, so an authorization that has expired, or
   * whose deadline is more than a day away, is refused before it is relayed.
   */
  private verifyStellar(
    pr: PaymentRequestView,
    requirements: PaymentRequirements,
    atum: AtumEscrowExtra,
  ): SourceVerdict {
    const recovered = this.recoverEd25519(pr, requirements, atum, {});
    if ('refused' in recovered) return recovered;

    const stale = staleDeadline(
      recovered.verified.deadlineSec,
      Math.floor(this.now() / 1000),
      'Stellar',
      STELLAR_MAX_DEPOSIT_WINDOW_SECS,
      'its deadline is more than a day away',
    );
    if (stale !== undefined) return { refused: stale };

    // Amount cap, receive side, routing fields and deadlines.
    return accepted(pr, requirements, atum, this.now(), recovered.verified.deadlineSec);
  }

  /**
   * Recover an Ed25519 (Solana or Stellar) deposit's signer and terms against the requirement,
   * which `extra` adds the chain's own inputs to, or refuse it.
   */
  private recoverEd25519(
    pr: PaymentRequestView,
    requirements: PaymentRequirements,
    atum: AtumEscrowExtra,
    extra: Partial<VerifyExpectations>,
  ): { refused: VerifyResponse } | { verified: VerifiedSenderAuth } {
    // As on EVM, the bind targets are the requirement's values, not the payload's.
    const commitment = commitmentOf(pr, this.depositRequestHashV2Mode, acceptsV2(atum));
    try {
      const verified = recoverSourceAuth(requirements.network).recoverAndVerify(
        pr.sender_auth.signed_messages[0] as SenderAuthMessage,
        {
          network: requirements.network,
          asset: requirements.asset,
          account: pr.source.account,
        },
        commitment.expectation,
        {
          maxSourceAmount: pr.max_source_amount,
          escrowContract: atum.escrow,
          reserver: atum.reserver,
          releaser: atum.releaser,
          ...extra,
        },
      );
      return { verified };
    } catch (err) {
      this.reportRefusal(err, commitment.strictDetail);
      return { refused: invalid((err as Error).message) };
    }
  }

  /**
   * Relay the request to Atum and map the result. Settlement is keyless: the network executes
   * the escrow/fulfillment.
   *
   * @remarks
   * Cross-chain settlement can outrun the gateway's synchronous window, so the gateway answers
   * in one of four ways and each maps to a distinct response:
   *
   * - a payout on chain, `finalizing` or `completed` — settled; `success: true` with the
   *   destination transaction and `extensions.atum.state`. With `settleAt: 'completed'`,
   *   `finalizing` is still pending;
   * - a payment id with a terminal status — {@link SETTLEMENT_FAILED}; the payment is dead;
   * - a payment id, still in flight — {@link SETTLEMENT_PENDING}, with `extensions.atum`
   *   carrying the id;
   * - neither — {@link SETTLEMENT_NOT_ACCEPTED}; the network took nothing.
   *
   * x402 has no "pending" outcome, so everything but the first has to travel as
   * `success: false`: the merchant must not hand over the goods. But a pending payment must not
   * look like one that never happened — funds may already be moving — and a *failed* one must
   * not look pending, because the two demand opposite actions from the payer:
   *
   * | reason                       | what the payer must do                                    |
   * | ---------------------------- | --------------------------------------------------------- |
   * | {@link SETTLEMENT_PENDING}   | re-attempt under the **same** idempotency key — that is how  |
   * |                              | the result is collected, and it resolves to this payment     |
   * | {@link SETTLEMENT_FAILED}    | a re-attempt needs a **new** key — the same one resolves   |
   * |                              | to this dead payment forever                               |
   *
   * The gateway's `status` is therefore read rather than inferred from the receipt's absence.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    // `/verify` and `/settle` are independent calls, so settle re-runs the full verification and
    // refuses to relay anything that fails. The trust lookup is the only I/O, and a successful
    // one is normally still cached from `/verify`.
    const verification = await this.verify(payload, requirements, context);
    if (!verification.isValid) {
      return {
        success: false,
        transaction: '',
        network: requirements.network,
        errorReason: verification.invalidReason ?? 'payment failed verification',
      };
    }

    const pr = paymentRequestOf(payload);

    let result: PaymentSubmitResult;
    try {
      result = await this.submitter.submit(pr, {
        shadow: depositRequestHashShadowOf(JSON.stringify(pr), 'x402'),
      });
    } catch (err) {
      // A refusal becomes a settle response carrying the gateway's reason. Anything else is an
      // infrastructure fault and propagates as a 5xx.
      if (isPaymentRejectedError(err)) {
        return {
          success: false,
          transaction: '',
          network: requirements.network,
          payer: pr.source.account,
          errorReason: err.code,
          errorMessage: err.message,
        };
      }
      throw err;
    }

    const settled = settledPayout(result);
    if (settled && (settled.state === 'completed' || this.settleAt === 'finalizing')) {
      const statusUrl =
        settled.state === 'finalizing' ? this.statusUrlFor?.(settled.paymentId) : undefined;
      return {
        success: true,
        transaction: settled.hash,
        network: settled.chainId as Network,
        payer: pr.source.account,
        // Lets a merchant key fulfillment on the payment rather than the request, so a reused
        // purchase identifier is not delivered twice (see the README's Idempotency section).
        extensions: {
          atum: {
            paymentId: settled.paymentId,
            state: settled.state,
            ...(statusUrl !== undefined ? { statusUrl } : {}),
          },
        },
      };
    }

    if (result.payment_id) {
      // An absent status reads as pending: calling a live payment "failed" has no safe recovery.
      const terminal = result.status === 'failed' || result.status === 'refunded';
      const statusUrl = this.statusUrlFor?.(result.payment_id);
      return {
        success: false,
        transaction: '',
        network: requirements.network,
        // Verification passed above, so the payer is known even though nothing settled.
        payer: pr.source.account,
        errorReason: terminal ? SETTLEMENT_FAILED : SETTLEMENT_PENDING,
        errorMessage: terminal
          ? 'the payment reached a terminal state without settling; re-submitting it under the ' +
            'same idempotency key resolves to this same payment, so a fresh attempt ' +
            'needs a NEW idempotency key'
          : PENDING_MESSAGE +
            missingPayoutNote(result) +
            (result.status === 'refund_available'
              ? '. It was not delivered and its deposit is still in escrow: read refund_signature ' +
                "from the payment's status and submit it to the source escrow to return the funds"
              : ''),
        extensions: {
          atum: {
            paymentId: result.payment_id,
            state: result.status ?? 'pending',
            ...(statusUrl !== undefined ? { statusUrl } : {}),
          },
        },
      };
    }

    // The response names no payment but reports one: a status or a transaction. Money may have
    // moved, so this is pending, never "not accepted", which would invite a second payment.
    if (result.status !== undefined || result.transactions !== undefined) {
      return {
        success: false,
        transaction: '',
        network: requirements.network,
        payer: pr.source.account,
        errorReason: SETTLEMENT_PENDING,
        errorMessage: PENDING_MESSAGE,
      };
    }

    // Nothing reported at all: nothing to wait on or correlate, so this is a plain failure.
    return {
      success: false,
      transaction: '',
      network: requirements.network,
      errorReason: SETTLEMENT_NOT_ACCEPTED,
      errorMessage:
        'the Atum network returned neither a payout transaction nor a payment id, so the ' +
        'payment was not accepted',
    };
  }
}

const PENDING_MESSAGE =
  'the payment was accepted by the Atum network and is still settling; re-attempt the ' +
  'purchase under the SAME idempotency key to collect the result — that resolves to this ' +
  'same payment and costs nothing. Do not pay again under a new key';

/**
 * The payout, the payment it belongs to, and how far it has got, or undefined until the gateway
 * reports a payout on chain. `status` decides; a payout hash alone never does.
 */
function settledPayout(
  result: PaymentSubmitResult,
):
  | { hash: string; chainId: string; paymentId: string; state: 'finalizing' | 'completed' }
  | undefined {
  const state =
    result.status === 'completed' || result.status === 'finalizing' ? result.status : undefined;
  const paymentId = result.payment_id;
  if (!state || !paymentId) return undefined;
  const payout = result.transactions?.fulfillment;
  if (!payout?.transaction_hash || !payout.chain_id) return undefined;
  return { hash: payout.transaction_hash, chainId: payout.chain_id, paymentId, state };
}

/**
 * Says so when the gateway reports the payout made but no payout reached the SDK. The payer reads
 * this, so it names no cause: a submitter that drops `transactions` and a gateway fault look the same
 * here. The payer is still told to wait: reporting the payment failed would invite a second payment.
 */
function missingPayoutNote(result: PaymentSubmitResult): string {
  if (result.status !== 'completed' && result.status !== 'finalizing') return '';
  const payout = result.transactions?.fulfillment;
  if (payout?.transaction_hash && payout.chain_id) return '';
  return `. The payment is ${result.status}, but its payout is not reported yet`;
}

export { registerAtumEscrowScheme, type AtumEscrowFacilitatorRegistrar } from './register';

/** Read and validate the `extra.atum` block of a requirement. */
function requireAtumExtra(requirements: PaymentRequirements) {
  const atum = (requirements.extra as { atum?: unknown } | undefined)?.atum;
  if (atum === undefined || atum === null) {
    throw new Error('atum-escrow: requirement is missing extra.atum');
  }
  assertAtumEscrowExtra(atum);
  return atum;
}

/**
 * Validate the payload envelope against the published schema (the facilitator's
 * inbound trust boundary) and extract the Atum PaymentRequest it carries.
 */
function paymentRequestOf(payload: PaymentPayload): PaymentRequestView {
  assertAtumEscrowPayload(payload);
  const pr = (payload as { payload?: { paymentRequest?: unknown } }).payload?.paymentRequest;
  if (pr === undefined || pr === null) {
    throw new Error('atum-escrow: payload is missing payload.paymentRequest');
  }
  // The request is relayed as verified, so the only signed message is the deposit.
  const messages = (pr as { sender_auth?: { signed_messages?: unknown } }).sender_auth
    ?.signed_messages;
  if (!Array.isArray(messages) || messages.length !== 1) {
    throw new Error('atum-escrow: sender_auth must carry exactly one signed message, the deposit');
  }
  return pr as PaymentRequestView;
}

/**
 * The one scheme this facilitator accepts on each source chain: the one this package's client
 * builds. Any other label, including others the shared SDK permits, is refused.
 */
const SCHEME_BY_NAMESPACE: ReadonlyMap<string, string> = new Map([
  ['eip155', 'EVM_PERMIT2'],
  ['tron', 'EVM_PERMIT2'],
  ['solana', 'SOLANA'],
  ['stellar', 'STELLAR'],
]);

/**
 * The longest a Stellar deposit's deadline can lie ahead of the ledger: the escrow requires
 * `deadline - issued_at` to be at most a day and `issued_at` not to be ahead of the ledger.
 *
 * Restated here because the shared library does not export its own copy of the bound. The day-long
 * budget cases in `facilitator-stellar.test.ts` hold the two together: the library's builder
 * refuses a longer validity, and this check refuses a deposit a second past it.
 */
const STELLAR_MAX_DEPOSIT_WINDOW_SECS = 86_400;

/**
 * The commitment the deposit is bound to: the request's own destination and request id, and, unless
 * the mode is off and when the requirement lists version 2 (`acceptsV2`), its depositRequestHash v2
 * if the strict reader admits the request, so a deposit may commit either version. A strict refusal
 * is returned as `strictDetail` and otherwise left to the payee check, which applies the mode to it.
 */
function commitmentOf(
  pr: PaymentRequestView,
  mode: CommitmentOptions['depositRequestHashV2Mode'],
  acceptsV2: boolean,
): {
  expectation: CommitmentExpectation;
  strictDetail: string;
} {
  const expectation: CommitmentExpectation = {
    destinations: pr.destination,
    requestId: pr.request_id,
  };
  if (mode === undefined) return { expectation, strictDetail: '' };
  try {
    const { depositRequestHashV2 } = readDepositRequest(JSON.stringify(pr));
    return {
      expectation: acceptsV2 ? { ...expectation, depositRequestHashV2 } : expectation,
      strictDetail: '',
    };
  } catch (err) {
    return { expectation, strictDetail: commitmentResultOf(err)?.detail ?? '' };
  }
}

/**
 * The refusal, in `retire` mode, of a requirement that does not list version 2: a v1 deposit is
 * retired and a v2 one is not offered, so no payer could pay it.
 */
const RETIRED_REQUIREMENT_WITHOUT_V2 =
  'atum-escrow: this facilitator accepts only depositRequestHash v2, but the requirement does not list 2 in extra.atum.depositRequestHashVersions, so no payment can satisfy it';

/**
 * Whether a deposit committing depositRequestHash v2 is accepted for this requirement: only when it
 * lists version 2. The merchant lists 2 once the network reads v2, so a v2 deposit the requirement
 * did not offer is refused at verify, before the merchant's handler runs, rather than at settle.
 */
function acceptsV2(atum: AtumEscrowExtra): boolean {
  return atum.depositRequestHashVersions?.includes(2) === true;
}

/** The Solana escrow domain the requirement names, or undefined when it names none. */
function solanaDomainOf(atum: AtumEscrowExtra): SolanaDomain | undefined {
  if (atum.svmSignatureDomainVersion === undefined) return undefined;
  return {
    escrowProgramId: atum.escrow,
    clusterId: atum.svmSignatureClusterId ?? '',
    domainVersion: atum.svmSignatureDomainVersion,
  };
}

/**
 * Refuse an Ed25519 authorization whose deadline has passed (including exactly now) or lies more
 * than `maxAheadSecs` ahead, the longest the escrow admits on that chain, before it is relayed.
 * Undefined when the deadline is inside the window.
 */
function staleDeadline(
  deadlineSec: number,
  nowSec: number,
  chain: string,
  maxAheadSecs: number,
  aheadDetail: string,
): VerifyResponse | undefined {
  if (deadlineSec <= nowSec) {
    return invalid(`${chain} deposit authorization has expired (deadline is in the past)`);
  }
  if (deadlineSec > nowSec + maxAheadSecs) {
    return invalid(`${chain} deposit authorization is not yet valid (${aheadDetail})`);
  }
  return undefined;
}

/** Shorthand for an invalid verify result. */
function invalid(reason: string): VerifyResponse {
  return { isValid: false, invalidReason: reason };
}

/**
 * The outcome of checking a payment's source authorization and terms: refused with the response
 * to return, or accepted with the payer and the earliest instant (epoch ms) the payment stays
 * valid until. The deadline travels with the acceptance because verification does I/O after
 * these checks, and has to re-judge it then.
 */
type SourceVerdict = { refused: VerifyResponse } | { payer: string; expiresAtMs: number };

/**
 * Run the checks shared by every source chain and, when they pass, accept the payment until the
 * earlier of its signed authorization deadline and its quote deadline.
 */
function accepted(
  pr: PaymentRequestView,
  requirements: PaymentRequirements,
  atum: AtumEscrowExtra,
  now: number,
  signedDeadlineSec: number,
): SourceVerdict {
  const refusal = checkReceiveAndDeadlines(pr, requirements, atum, now);
  if (refusal !== null) return { refused: refusal };
  return {
    payer: pr.source.account,
    expiresAtMs: Math.min(signedDeadlineSec * 1000, Date.parse(pr.quote_deadline)),
  };
}

/**
 * Require that the payment's `request_id` really is derived from the identifier of the purchase it
 * claims to pay for and from the page the resource server is charging for.
 *
 * The Atum network de-duplicates on `request_id`, so a payment can only be safely re-attempted
 * when its `request_id` derives from the purchase identifier, the source account and the page. A
 * payment with any other `request_id`, with no identifier, or for another page, is refused before
 * anything moves. The page is read from the requirements the resource server passed, never from
 * the payer's echoed `accepted`, so a payment made for one page cannot be presented for another.
 *
 * @throws if no identifier or resource is available, or `request_id` was not derived from them
 */
function requirePaymentAnchoredToItsIdentifier(
  pr: PaymentRequestView,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): void {
  const identifier = resolvePaymentIdentifier(payload.extensions);
  const resource = requireAtumResource(requirements);
  if (pr.request_id !== atumEscrowRequestId(identifier, pr.source.account, resource)) {
    throw new Error(
      "request_id is not derived from this purchase's identifier and page, so re-attempting the " +
        'payment would not resolve to it and would be charged again',
    );
  }
}

// Clock-skew tolerance (ms) when checking a payer-supplied deadline against the advertised
// budget: verification runs after signing, possibly on a different clock.
const DEADLINE_SKEW_TOLERANCE_MS = 60_000;

/**
 * Amount-cap, source-asset, routing, receive-side and deadline checks shared by every source
 * chain. Addresses use chain-aware equality and asset ids are reconstructed by the relevant
 * chain's adapter, so every corridor direction is handled the same way. Returns an invalid
 * result, or `null` when all checks pass.
 */
function checkReceiveAndDeadlines(
  pr: PaymentRequestView,
  requirements: PaymentRequirements,
  atum: AtumEscrowExtra,
  now: number,
): VerifyResponse | null {
  // Cap: the advertised source spend must not exceed the requirement.
  if (BigInt(pr.max_source_amount) > BigInt(requirements.amount)) {
    return invalid('max_source_amount exceeds the requirement amount cap');
  }

  // The signed token is bound above, but the top-level source.asset_identifier is a separate,
  // unsigned string, so bind it to the requirement too.
  const expectedSourceAsset = getChainAdapter(requirements.network).assetIdentifier(
    requirements.network,
    requirements.asset,
  );
  if (pr.source.asset_identifier !== expectedSourceAsset) {
    return invalid('source asset does not match the requirement');
  }

  // Routing fields settlement acts on. The source signature does not cover them, so each must
  // match the requirement (extra.atum); a missing field is a mismatch. This includes
  // fulfillment_verifier.endpoint, a URL a settler may fetch.
  if (!caipEqual(requirements.network, pr.escrow_contract_address ?? '', atum.escrow)) {
    return invalid('escrow_contract_address does not match the requirement escrow');
  }
  if (!caipEqual(requirements.network, pr.quote_selector ?? '', atum.reserver)) {
    return invalid('quote_selector does not match the requirement reserver');
  }
  if (!caipEqual(requirements.network, pr.fulfillment_verifier?.account ?? '', atum.releaser)) {
    return invalid('fulfillment_verifier.account does not match the requirement releaser');
  }
  // fulfillment happens on the destination chain, so its proxy is a destination-chain address.
  if (!caipEqual(atum.destination.network, pr.fulfillment_proxy ?? '', atum.fulfillmentProxy)) {
    return invalid('fulfillment_proxy does not match the requirement');
  }
  // A URL, not an address: exact match against the merchant's advertised verifier endpoint.
  if ((pr.fulfillment_verifier?.endpoint ?? '') !== atum.fulfillmentVerifierEndpoint) {
    return invalid('fulfillment_verifier.endpoint does not match the requirement');
  }

  // Receive side must be exactly what the merchant advertised, across a possibly-different
  // destination chain.
  const dest = pr.destination[0];
  if (!caipEqual(atum.destination.network, dest.account, atum.destination.address)) {
    return invalid('destination account does not match the requirement');
  }
  const expectedDestAsset = getChainAdapter(atum.destination.network).assetIdentifier(
    atum.destination.network,
    atum.destination.asset,
  );
  if (dest.asset_identifier !== expectedDestAsset) {
    return invalid('destination asset does not match the requirement');
  }
  if (pr.fulfillment_amount !== atum.fulfillmentAmount) {
    return invalid('fulfillment_amount does not match the requirement');
  }

  // Deadline ordering: now < quote_deadline < fulfillment_deadline.
  const quote = Date.parse(pr.quote_deadline);
  const fulfillment = Date.parse(pr.fulfillment_deadline);
  if (!(now < quote && quote < fulfillment)) {
    return invalid('deadline ordering violated (now < quote_deadline < fulfillment_deadline)');
  }

  // The absolute deadlines must not exceed the merchant's advertised relative budgets (plus
  // skew tolerance), so a payer cannot stretch the quote or settlement window.
  if (quote > now + atum.quoteDeadlineSeconds * 1000 + DEADLINE_SKEW_TOLERANCE_MS) {
    return invalid('quote_deadline exceeds the advertised budget');
  }
  if (fulfillment > now + atum.fulfillmentDeadlineSeconds * 1000 + DEADLINE_SKEW_TOLERANCE_MS) {
    return invalid('fulfillment_deadline exceeds the advertised budget');
  }
  return null;
}

// The facilitator's `trust` option takes the same resolver the client uses, so its building
// blocks are importable from this entry too.
export {
  AtumEscrowTrustError,
  ATUM_DEFAULT_TRUST_GATEWAYS,
  atumGatewayTrust,
  type AtumEscrowTrustErrorCode,
  type AtumGatewayTrustOptions,
  type TrustResolver,
  type TrustedRoles,
  type TrustedToken,
} from '../client/trust';
