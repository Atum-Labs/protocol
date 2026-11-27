/*
 * Copyright 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Merchant-side entry point for the Atum escrow MPP payment method.
 *
 * Register the returned method into your `mppx` server to accept `atum-escrow`
 * payments, and use {@link buildChargeRequest} / {@link corridorFromDefaults} to construct
 * the `402` challenges. Verification recovers the source-chain deposit authorization per
 * chain (EVM, Tron, Solana) and settles through the Atum Payment Gateway.
 *
 * @example
 * ```ts
 * import { Mppx } from 'mppx/server'
 * import { registerServer } from '@atumlabs/mppx-atum-escrow/server'
 *
 * const method = registerServer({ submitter })
 * const mppx = Mppx.create({ realm: 'api.example.com', secretKey, methods: [method] })
 * ```
 *
 * @packageDocumentation
 */

import {
  commitmentLogFields,
  commitmentResultOf,
  depositRequestHashShadowOf,
  getChainAdapter,
  publishedDepositRequestHashVersions,
  REPLAY_HORIZON_SECS,
  readDepositRequest,
  verifyRequestCommitment,
  type CommitmentExpectation,
  type CommitmentOptions,
  type CommitmentResult,
  type DepositRequestHashShadow,
  type SignedMessageInput,
} from '@atum-labs/payment-request-sender-auth';
import type { ChainDefaults } from '@atum-labs/payment-gateway-client';
import { Errors, Method } from 'mppx';
import type { Receipt } from 'mppx';
import {
  METHOD_NAME,
  atumEscrowChargeMethod,
  assetIdentifier,
  chargeRequestId,
  contractOverridesFromExtra,
  intentIdOf,
  namespaceOf,
  resolveTronPermit2,
  sameAddress,
  sameAssetIdentifier,
  INTENT_ID_META_KEY,
  type ChargeRequest,
  type PaymentRequest,
} from './internal.js';
import { SettlementFailedError, SettlementPendingError } from './errors.js';
import { DEFAULT_PEG_GROUPS, comparable } from './cap.js';
import { MAX_TOKEN_DECIMALS, isTokenDecimals, maxSourceAmount } from './source-cap.js';

// Re-export the shared building blocks a merchant integration needs, so `/server` is a
// complete entry point without importing from the package root.
export {
  atumEscrowChargeMethod,
  ChargeRequestSchema,
  CredentialPayloadSchema,
  METHOD_NAME,
  INTENT,
  INTENT_ID_META_KEY,
} from './internal.js';
export {
  PaymentRejectedError,
  PaymentRetryableError,
  SettlementFailedError,
  SettlementPendingError,
  gatewayRefusalOf,
  isPaymentRejected,
  isPaymentRetryable,
  isSettlementFailed,
  isSettlementPending,
  type SettlementErrorDetails,
} from './errors.js';
export type {
  AtumEscrowChallenge,
  AtumEscrowCredential,
  ChargeRequest,
  ChargeCredentialPayload,
  PaymentRequest,
} from './internal.js';

/**
 * Clock-skew tolerance (ms) allowed when checking that a signed deadline does not
 * exceed the challenge's advertised budget. Verification happens after signing, so
 * the payer's clock may legitimately be ahead of the verifier's by a small margin.
 */
const DEADLINE_SKEW_TOLERANCE_MS = 60_000;

/**
 * Maximum fulfillment-deadline budget (seconds) a corridor with a Solana source may
 * advertise. The escrow's `deposit` instruction requires `issued_at <= now` and
 * `deadline <= issued_at + REPLAY_HORIZON_SECS`, and the permit deadline tracks the fulfillment
 * budget, so a longer budget would make the deposit transaction revert. Derived from the
 * on-chain replay horizon minus the adapter's issued-at guard.
 */
const SOLANA_MAX_FULFILLMENT_DEADLINE_SECONDS = REPLAY_HORIZON_SECS - 10;

/* ────────────────────────── Server (merchant) config ───────────────────────── */

/**
 * A token the merchant settles in. Only `address` reaches the challenge; `symbol` and `decimals`
 * must match what Atum's gateway `GET /v1/defaults` lists for the token, because payers price
 * the challenge with the values their trust source reports.
 */
export interface AtumEscrowAsset {
  /** Token contract address (mint on Solana), as it should appear on the wire. */
  address: string;
  /** Ticker, compared with the destination's to establish the two tokens are the same money. */
  symbol: string;
  /** Decimals: the unit the token's atomic amounts are counted in. */
  decimals: number;
}

/** One source chain/token the merchant accepts payment from. */
export interface AtumEscrowSource {
  /** CAIP-2 source chain id (e.g. `eip155:8453`, `tron:mainnet`, `solana:<genesis>`). */
  network: string;
  /**
   * Source tokens the payer may fund with on this network. All tokens on the same chain share
   * the escrow/role/verifier fields below, so accepting several tokens on one chain is a single
   * source with multiple `assets` — no need to duplicate the entry.
   */
  assets: ReadonlyArray<AtumEscrowAsset>;
  /** Source-chain escrow contract; the payer's funds lock here. */
  escrow: string;
  /** Source-chain role address that witnesses the escrow deposit on reservation. */
  reserver: string;
  /** Source-chain role address that witnesses the escrow release on fulfillment. */
  releaser: string;
  /** Source-chain endpoint used to verify fulfillment. */
  fulfillmentVerifierEndpoint: string;
  /** Solana-only: cluster id that domain-separates the deposit authorization. */
  svmSignatureClusterId?: string;
  /** Solana-only: signature domain version that domain-separates the deposit authorization. */
  svmSignatureDomainVersion?: number;
  /**
   * The depositRequestHash versions a payer may sign for this source, published as
   * `extra.depositRequestHashVersions`: 1 is keccak256 of the request_id, 2 is the hash of the
   * payment terms. Absent publishes nothing, which payers read as `[1]`. List what the gateway's
   * `GET /v1/defaults` lists in `deposit_request_hash_versions` for this source chain, exactly as it
   * lists them. {@link corridorFromDefaults} does that.
   */
  depositRequestHashVersions?: number[];
}

/** Corridor configuration: what the merchant receives and which sources it accepts. */
export interface AtumEscrowCorridor {
  /**
   * Where the merchant receives: CAIP-2 chain, token, and receive account, plus the token's
   * ticker and decimals. Only the chain, token and account reach the challenge.
   */
  destination: {
    network: string;
    asset: string;
    account: string;
    symbol: string;
    decimals: number;
  };
  /** Destination-chain fulfillment-proxy contract. */
  fulfillmentProxy: string;
  /** Markup over `fulfillmentAmount` to derive each source cap, in basis points (e.g. `300` = 3%). */
  markupBps: number;
  /**
   * Quote-deadline budget in seconds, counted from when the payer builds the payment. Bidding
   * closes at the quote deadline. The payer's clock skew also comes out of this budget, and only
   * the merchant can widen it.
   */
  quoteDeadlineSeconds: number;
  /** Fulfillment-deadline budget in seconds, counted from when the payer builds the payment. */
  fulfillmentDeadlineSeconds: number;
  /** Accepted source options; selected per charge by `(network, asset)`. */
  sources: AtumEscrowSource[];
  /**
   * Groups of token symbols treated as the same money. Replaces the default, which is the same
   * `DEFAULT_PEG_GROUPS` the payer client uses when its payer sets none; match the groups your
   * payers use, or a corridor this server accepts is one they refuse.
   */
  pegGroups?: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * Why the server refused a corridor or a charge. `INVALID_CONFIG` is a malformed field (the
 * message names it); `ASSETS_NOT_COMPARABLE` is a source token that is not the same money as the
 * destination token, which payers would refuse to price; `INVALID_AMOUNT` is a `fulfillmentAmount`
 * that is not a plain base-10 integer; `CAP_BELOW_PRICE` is a charge whose cap, rounded down to a
 * whole source atomic unit, is worth less than the fulfillment, which no settler could fill;
 * `AMOUNT_EXCEEDS_CHAIN_LIMIT` is a fulfillment or cap larger than its chain's amount type holds.
 */
export type AtumEscrowConfigErrorCode =
  | 'INVALID_CONFIG'
  | 'ASSETS_NOT_COMPARABLE'
  | 'INVALID_AMOUNT'
  | 'CAP_BELOW_PRICE'
  | 'AMOUNT_EXCEEDS_CHAIN_LIMIT';

/**
 * A corridor or a charge the server refuses. Thrown by {@link validateCorridor} and the
 * builders.
 */
export class AtumEscrowConfigError extends Error {
  readonly code: AtumEscrowConfigErrorCode;
  /**
   * The network at fault: the source for `ASSETS_NOT_COMPARABLE` and `CAP_BELOW_PRICE`, and the
   * chain whose limit was exceeded for `AMOUNT_EXCEEDS_CHAIN_LIMIT`.
   */
  readonly network?: string;

  constructor(init: {
    code: AtumEscrowConfigErrorCode;
    message: string;
    network?: string;
    cause?: unknown;
  }) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'AtumEscrowConfigError';
    this.code = init.code;
    if (init.network !== undefined) this.network = init.network;
  }
}

function invalidConfig(message: string, cause?: unknown): AtumEscrowConfigError {
  return new AtumEscrowConfigError({ code: 'INVALID_CONFIG', message, cause });
}

const UINT256_MAX = (1n << 256n) - 1n;
const U64_MAX = (1n << 64n) - 1n;

/**
 * The largest token amount the chain's amount type holds: uint256 on EVM and Tron, u64 on
 * Solana. `undefined` for a chain family this package does not know, which is not checked.
 */
function amountCeiling(network: string): bigint | undefined {
  switch (namespaceOf(network)) {
    case 'eip155':
    case 'tron':
      return UINT256_MAX;
    case 'solana':
      return U64_MAX;
    default:
      return undefined;
  }
}

function assertWithinChainLimit(amount: bigint, network: string, what: string): void {
  const ceiling = amountCeiling(network);
  if (ceiling !== undefined && amount > ceiling) {
    throw new AtumEscrowConfigError({
      code: 'AMOUNT_EXCEEDS_CHAIN_LIMIT',
      network,
      message: `atum-escrow: ${what} ${amount} exceeds the largest amount ${network} can hold (${ceiling})`,
    });
  }
}

/** A config value as the merchant wrote it: a string stays quoted so `"6"` does not read as `6`. */
function renderValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function isPegGroups(value: unknown): value is ReadonlyArray<ReadonlyArray<string>> {
  return (
    Array.isArray(value) &&
    value.every(
      (group) => Array.isArray(group) && group.every((s) => typeof s === 'string' && s !== ''),
    )
  );
}

/**
 * Lifecycle state the gateway reports for a payment.
 *
 * `finalizing` means the payout is on chain but not yet final. Whether that counts as settled is
 * {@link AtumEscrowServerConfig.settleAt}. `refunding` and `refund_available` are not terminal: on
 * `refund_available` the funds are still in escrow until someone submits the refund signature, and
 * a late delivery can still complete it. `failed` and `refunded` are terminal, and a payer must
 * never start a second payment for one that is still in flight.
 */
export type PaymentSettlementStatus =
  'pending' | 'finalizing' | 'completed' | 'failed' | 'refunding' | 'refund_available' | 'refunded';

/**
 * The payment status at which `verify()` returns a receipt: `finalizing` (the payout is on
 * chain, not yet final) or `completed` (final).
 */
export type SettleAt = 'finalizing' | 'completed';

/** One on-chain transaction of a payment, as the gateway reports it under `transactions`. */
export interface PaymentTransactionView {
  transaction_hash: string;
  /** CAIP-2 id of the chain the transaction is on. */
  chain_id: string;
  block_number?: number;
}

/**
 * The transactions a payment has produced so far: the payer's deposit on the source chain and
 * the payout to the recipient on the destination chain.
 */
export interface PaymentTransactionsView {
  deposit?: PaymentTransactionView;
  fulfillment?: PaymentTransactionView;
}

/** What a {@link PaymentSubmitter} resolves with. */
export interface PaymentSubmitResult {
  /** The gateway's payment id. Present whenever the payment was accepted. */
  payment_id?: string;
  /**
   * The payment's state. When absent, an unsettled payment is treated as still in flight —
   * the conservative reading, since calling an in-flight payment failed would tell the payer to
   * start a second one.
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
 * Submits a signed payment request to the Atum Payment Gateway and resolves with the
 * settlement result. Satisfied by an adapter over `@atum-labs/payment-gateway-client`.
 *
 * Submit and return what the gateway said; do not poll for completion inside the submitter.
 * A payment that outlives the gateway's synchronous window surfaces to the payer as
 * {@link SettlementPendingError}, and the payer's retry of the same purchase resolves to the same
 * payment and collects the result.
 *
 * When the gateway answers with an error that refuses the payment, throw the refusal it is, so it
 * keeps its code and the payer is told what to do next: a {@link PaymentRetryableError} when the
 * same purchase can go through unchanged in a moment, a {@link PaymentRejectedError} when it
 * cannot. Any other throw is treated as an unknown outcome. {@link gatewayRefusalOf} decides which
 * an answer is: end the submitter's `catch` with `throw gatewayRefusalOf(err) ?? err`.
 */
export interface PaymentSubmitter {
  submit(request: PaymentRequest, context?: PaymentSubmitContext): Promise<PaymentSubmitResult>;
}

/** What the server hands a {@link PaymentSubmitter} with the request it submits. */
export interface PaymentSubmitContext {
  /**
   * Who built the request (`mppx`) and its depositRequestHash v2 as submitted. Forward it as the
   * `X-Atum-Producer` and `X-Atum-Deposit-Request-Hash-V2` headers: with the gateway client, spread
   * `submitPaymentShadow(context.shadow)` into `submitPayment`. Used for compatibility diagnostics
   * only; it never changes how the payment is processed.
   */
  shadow: DepositRequestHashShadow;
}

/** Configuration for the merchant side of the method. */
export interface AtumEscrowServerConfig {
  /** The gateway settlement is submitted through. */
  submitter: PaymentSubmitter;
  /** Clock (epoch ms) used to validate deadline ordering and budgets. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Called with the result of every payee check, admissions and refusals alike, so you can count
   * payments by `logFields.sender_auth_result` and log each refusal with all of `logFields`. A
   * refused payment still throws; an exception from this callback on an admission refuses the
   * payment with a fixed message.
   */
  onCommitmentResult?: (result: CommitmentResult, logFields: Record<string, string>) => void;
  /**
   * How the payee check reads depositRequestHash v2. `audit`, the default, accepts a deposit
   * committing v1 or v2, and also admits a request the strict reader refuses, by the v1 reading,
   * reporting why in `CommitmentResult.strictDetail`. `enforce` accepts v1 or v2 and refuses that
   * request as `request_malformed`. `retire` is `enforce` that accepts only v2: a deposit committing
   * v1 is refused as `request_hash_mismatch` before it is submitted. Set `retire` once every payer
   * you serve signs v2, which a client does when the challenge lists 2 in
   * `depositRequestHashVersions`. Any other value is refused by {@link registerServer}.
   */
  depositRequestHashV2Mode?: CommitmentOptions['depositRequestHashV2Mode'];
  /**
   * The payment status at which `verify()` returns a receipt. `finalizing`, the default, serves
   * the resource as soon as the payout is on chain; a chain reorganization could still drop that
   * transaction, and serving then is accepting that risk. `completed` waits for finality, minutes
   * on some chains, and throws {@link SettlementPendingError} until then.
   */
  settleAt?: SettleAt;
}

export type {
  CommitmentResult,
  CommitmentOutcome,
  DepositRequestHashShadow,
} from '@atum-labs/payment-request-sender-auth';

/**
 * The commitment the deposit is bound to: the request's own destination and request id, and its
 * depositRequestHash v2 when the strict reader admits the request, so a deposit may commit either
 * version. A strict refusal is returned as `strictDetail` and otherwise left to the payee check,
 * which applies the configured mode to it.
 */
function commitmentOf(pr: PaymentRequest): {
  expectation: CommitmentExpectation;
  strictDetail: string;
} {
  const expectation: CommitmentExpectation = {
    destinations: pr.destination,
    requestId: pr.request_id ?? '',
  };
  try {
    const { depositRequestHashV2 } = readDepositRequest(JSON.stringify(pr));
    return { expectation: { ...expectation, depositRequestHashV2 }, strictDetail: '' };
  } catch (err) {
    return { expectation, strictDetail: commitmentResultOf(err)?.detail ?? '' };
  }
}

/**
 * Runs a payee check and reports its result, admitted or refused, to `onCommitmentResult`. A
 * refusal is reported with `strictDetail` when one is given: the audit-mode reason the strict
 * reader refused the same request.
 */
function checkCommitment<T>(
  config: AtumEscrowServerConfig,
  check: () => { value: T; result: CommitmentResult },
  strictDetail = '',
): T {
  let checked: { value: T; result: CommitmentResult };
  try {
    checked = check();
  } catch (e) {
    const carried = commitmentResultOf(e);
    if (carried !== undefined) {
      const refused = strictDetail !== '' ? { ...carried, strictDetail } : carried;
      try {
        config.onCommitmentResult?.(refused, commitmentLogFields(refused));
      } catch {
        // The refusal stands whatever the callback does.
      }
    }
    throw e;
  }
  try {
    config.onCommitmentResult?.(checked.result, commitmentLogFields(checked.result));
  } catch {
    // The callback's own error is not the payer's to see.
    throw new Error('atum-escrow: the payment could not be recorded, so it is refused');
  }
  return checked.value;
}

/**
 * The receipt `verify()` resolves with: the MPP receipt plus the Atum payment it settled.
 * `reference` is the payout transaction hash on `destinationChainId`.
 */
export type AtumEscrowReceipt = Receipt.Receipt & {
  /** The Atum payment id, for status lookups and reconciliation. */
  paymentId: string;
  /** `finalizing`: the payout is on chain, not yet final. `completed`: final. */
  state: 'finalizing' | 'completed';
  /** CAIP-2 id of the chain `reference` is on. */
  destinationChainId: string;
};

/**
 * The merchant-side method {@link registerServer} returns, ready to register into an
 * `mppx` server via `Mppx.create({ methods: [method] })`.
 *
 * Name this type when the method is built in one place and registered in another — for
 * example a factory that assembles the corridor and submitter for your environment. Its
 * `verify()` resolves with an {@link AtumEscrowReceipt}, so the payout transaction, payment id and state are
 * available directly on the result.
 */
export type AtumEscrowServer = Omit<
  // `{}` is how mppx's Method.Server generic spells "nothing extra at this slot"; `object` or
  // `unknown` would change assignability against the upstream types.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  Method.Server<typeof atumEscrowChargeMethod, {}, undefined, {}, undefined>,
  'verify'
> & {
  verify: (
    parameters: Method.VerifyContext<typeof atumEscrowChargeMethod>,
  ) => Promise<AtumEscrowReceipt>;
};

/**
 * The one scheme the server accepts on each source chain: the one this package's client builds.
 * Any other label, including others the shared SDK permits, is refused.
 */
const SCHEME_BY_NAMESPACE: ReadonlyMap<string, string> = new Map([
  ['eip155', 'EVM_PERMIT2'],
  ['tron', 'EVM_PERMIT2'],
  ['solana', 'SOLANA'],
]);

/**
 * Configure the merchant side of the method.
 *
 * The returned method verifies an incoming credential and settles it through the Atum
 * Payment Gateway, resolving with an {@link AtumEscrowReceipt} once the payout is on chain
 * (or final, with `settleAt: 'completed'`). Verification throws if the credential is invalid
 * or the payment has not reached that point. The inbound request is held open while the
 * gateway settles, up to its synchronous window, so client and server timeouts must allow
 * for that window.
 *
 * The corridor is not part of the server configuration: verification trusts the
 * HMAC-bound challenge (carried in `request`) as the source of truth for the payment
 * terms, so one registration serves every corridor the merchant advertises.
 *
 * @param config - the gateway submitter and options.
 */
export function registerServer(config: AtumEscrowServerConfig): AtumEscrowServer {
  const now = config.now ?? (() => Date.now());
  const depositRequestHashV2Mode = config.depositRequestHashV2Mode ?? 'audit';
  if (
    depositRequestHashV2Mode !== 'audit' &&
    depositRequestHashV2Mode !== 'enforce' &&
    depositRequestHashV2Mode !== 'retire'
  ) {
    throw new Error(
      `atum-escrow: depositRequestHashV2Mode must be 'audit', 'enforce' or 'retire', not ${JSON.stringify(depositRequestHashV2Mode)}`,
    );
  }
  const settleAt = config.settleAt ?? 'finalizing';
  if (settleAt !== 'finalizing' && settleAt !== 'completed') {
    throw new Error(
      `atum-escrow: settleAt must be 'finalizing' or 'completed', not ${JSON.stringify(settleAt)}`,
    );
  }
  // `Method.toServer` types `verify` from the method rather than from the handler below, which
  // erases the receipt's Atum-specific fields; the assertion on the return restores them.
  return Method.toServer(atumEscrowChargeMethod, {
    async verify({ credential, request }): Promise<AtumEscrowReceipt> {
      const pr = credential.payload.paymentRequest as unknown as PaymentRequest;
      const { source, extra } = request;
      const namespace = namespaceOf(source.network);

      // Local checks only, no chain I/O; the gateway re-validates the whole request on submit.
      // The request is relayed as verified, so the only signed message is the deposit.
      const senderAuth = pr.sender_auth;
      if (!senderAuth || senderAuth.signed_messages.length === 0) {
        throw new Error('atum-escrow: credential is missing sender_auth');
      }
      if (senderAuth.signed_messages.length !== 1) {
        throw new Error(
          'atum-escrow: sender_auth must carry exactly one signed message, the deposit',
        );
      }
      const signed = senderAuth.signed_messages[0];
      if (!signed.message_prehash) {
        throw new Error('atum-escrow: sender_auth is missing message_prehash');
      }
      if (!pr.source) {
        throw new Error('atum-escrow: credential is missing a source');
      }
      // The deposit is verified for the challenge's chain, so it must declare the scheme verified there.
      if (senderAuth.message_scheme !== SCHEME_BY_NAMESPACE.get(namespace)) {
        throw new Error(
          `atum-escrow: unsupported message_scheme for ${source.network}: ${senderAuth.message_scheme}`,
        );
      }

      // The declared max_source_amount must not exceed the corridor's source cap. Checked before
      // signature recovery so an inflated cap fails with this specific error.
      const maxSourceStr = pr.max_source_amount ?? '0';
      if (!/^(?:0|[1-9][0-9]*)$/.test(maxSourceStr)) {
        throw new Error('atum-escrow: max_source_amount is not a decimal integer string');
      }
      const cap = BigInt(source.amount);
      if (BigInt(maxSourceStr) > cap) {
        throw new Error('atum-escrow: max_source_amount exceeds the source cap');
      }

      // Receive side must be exactly what the merchant advertised. These are plain request
      // fields, so they are checked first; recoverAndVerify then requires the signed deposit to
      // commit to this same destination and request id.
      const dest = pr.destination?.[0];
      if (!dest) {
        throw new Error('atum-escrow: credential is missing a destination');
      }
      if (!sameAddress(dest.account, extra.destination.address)) {
        throw new Error('atum-escrow: destination account does not match the challenge');
      }
      const expectedDestAsset = assetIdentifier(extra.destination.network, extra.destination.asset);
      // The identifier embeds the token address, so it follows sameAddress rather than a whole
      // string fold: a Tron `trc20:` reference is base58, where case is part of the value.
      if (!sameAssetIdentifier(dest.asset_identifier, expectedDestAsset)) {
        throw new Error('atum-escrow: destination asset does not match the challenge');
      }
      if (pr.fulfillment_amount !== extra.fulfillmentAmount) {
        throw new Error('atum-escrow: fulfillment_amount does not match the challenge');
      }

      // Recover the signer to pr.source.account and bind the signed terms against the challenge's
      // source network and asset (not the client-supplied pr.source): token, amount, EVM/Tron
      // freshness, spender == escrow, the witness roles, and the destination and request id the
      // deposit commits to.
      const commitment = commitmentOf(pr);
      const authTerms = checkCommitment(
        config,
        () => {
          const verified = getChainAdapter(source.network).recoverAndVerify(
            signed as SignedMessageInput,
            { network: source.network, asset: source.asset, account: pr.source.account },
            commitment.expectation,
            {
              maxSourceAmount: maxSourceStr,
              escrowContract: extra.escrow,
              reserver: extra.reserver,
              releaser: extra.releaser,
              svmSignatureClusterId: extra.svmSignatureClusterId,
              svmSignatureDomainVersion: extra.svmSignatureDomainVersion,
              // Use the same clock as the deadline checks below, so an injected `now` applies
              // throughout.
              nowSec: Math.floor(now() / 1000),
            },
          );
          // The request must read the same to every reader where it is read, and its signed
          // deposit must pay the request's own destination and request id under a scheme its source
          // chain permits.
          // The object checked here is the object submitted.
          const result = verifyRequestCommitment(
            JSON.stringify(pr),
            extra.svmSignatureDomainVersion == null
              ? undefined
              : {
                  escrowProgramId: extra.escrow,
                  clusterId: extra.svmSignatureClusterId ?? '',
                  domainVersion: extra.svmSignatureDomainVersion,
                },
            { depositRequestHashV2Mode },
          );
          return { value: verified, result };
        },
        depositRequestHashV2Mode === 'audit' ? commitment.strictDetail : '',
      );

      // The gateway de-duplicates on `request_id`, so it must be derived from the challenge's
      // HMAC-bound purchase identifier and the recovered account; otherwise a payer could reuse
      // the request id of an already-settled payment and be served twice for one charge.
      const intentId = intentIdOf(credential.challenge);
      if (intentId === undefined) {
        throw new Error(
          `atum-escrow: the challenge carries no '${INTENT_ID_META_KEY}' metadata, so this ` +
            'payment cannot be de-duplicated and is refused',
        );
      }
      if (pr.request_id !== chargeRequestId(intentId, pr.source.account)) {
        throw new Error(
          "atum-escrow: request_id is not derived from the challenge's purchase identifier, so a " +
            'retry of this payment would not de-duplicate',
        );
      }

      // The deposit signature does not cover the settlement-routing fields, so each must equal
      // the value the challenge implies, reconstructed the same way the client builds it.
      const overrides = contractOverridesFromExtra(source.network, extra);
      const expectedQuoteSelector = overrides?.quote_selector ?? extra.reserver;
      const expectedVerifier = overrides?.fulfillment_verifier ?? {
        account: extra.releaser,
        endpoint: extra.fulfillmentVerifierEndpoint,
      };
      if (!sameAddress(pr.escrow_contract_address ?? '', extra.escrow)) {
        throw new Error('atum-escrow: escrow_contract_address does not match the challenge');
      }
      if (!sameAddress(pr.quote_selector ?? '', expectedQuoteSelector)) {
        throw new Error('atum-escrow: quote_selector does not match the challenge reserver');
      }
      if (!sameAddress(pr.fulfillment_proxy ?? '', extra.fulfillmentProxy)) {
        throw new Error('atum-escrow: fulfillment_proxy does not match the challenge');
      }
      if (!sameAddress(pr.fulfillment_verifier?.account ?? '', expectedVerifier.account)) {
        throw new Error(
          'atum-escrow: fulfillment_verifier.account does not match the challenge releaser',
        );
      }
      if ((pr.fulfillment_verifier?.endpoint ?? '') !== expectedVerifier.endpoint) {
        throw new Error('atum-escrow: fulfillment_verifier.endpoint does not match the challenge');
      }

      const nowMs = now();
      const quote = Date.parse(pr.quote_deadline);
      const fulfillment = Date.parse(pr.fulfillment_deadline);

      // Ordering: quote collection has to close before settlement is due. This is a malformed
      // request, reported separately from the freshness check below.
      if (!(quote < fulfillment)) {
        throw new Error(
          'atum-escrow: quote_deadline must be before fulfillment_deadline (quote collection has ' +
            'to close before settlement is due)',
        );
      }

      // Freshness: the quote window must still be open for this authorization to start a payment.
      // The deadlines are absolute, so a stored credential cannot be re-presented; the payer must
      // fetch a fresh challenge and re-sign. Thrown as a PaymentError because mppx replaces any
      // other error from verify() with a generic message, and as the same type
      // SettlementPendingError uses because the payer's action is the same.
      if (!(nowMs < quote)) {
        throw new Errors.PaymentActionRequiredError({
          reason:
            "this authorization's quote window has already closed (quote_deadline is in the past), " +
            'so it cannot start a payment. To re-attempt a purchase, request a fresh challenge and ' +
            'sign it again, keeping the SAME intent id — the re-attempt then resolves onto the ' +
            'payment already in flight instead of taking a second one. A stored credential cannot ' +
            'be re-presented: its deadlines are fixed at the moment it was signed',
        });
      }
      // Upper bound: the signed deadlines must not exceed the challenge's advertised budgets
      // (plus skew tolerance), so a payer cannot stretch the settlement window.
      if (quote > nowMs + extra.quoteDeadlineSeconds * 1000 + DEADLINE_SKEW_TOLERANCE_MS) {
        throw new Error('atum-escrow: quote_deadline exceeds the advertised budget');
      }
      if (
        fulfillment >
        nowMs + extra.fulfillmentDeadlineSeconds * 1000 + DEADLINE_SKEW_TOLERANCE_MS
      ) {
        throw new Error('atum-escrow: fulfillment_deadline exceeds the advertised budget');
      }
      // EVM/Tron: the deposit authorization must not expire before the fulfillment deadline.
      // Solana authorizations are bounded by the escrow's replay window instead.
      if (namespace !== 'solana' && authTerms.deadlineSec * 1000 < fulfillment) {
        throw new Error('atum-escrow: permit deadline expires before fulfillment_deadline');
      }

      // Settle: submit and block on the gateway's synchronous window.
      const result = await config.submitter.submit(pr, {
        shadow: depositRequestHashShadowOf(JSON.stringify(pr), 'mppx'),
      });
      const settled = settledPayout(result);
      if (!settled || (settled.state === 'finalizing' && settleAt !== 'finalizing')) {
        // MPP has no failure receipt, so this throws either way. Pending (retry this purchase) and
        // failed (start a new one) stay distinct errors; an absent status reads as pending, since
        // wrongly reporting failure would invite a second charge.
        const terminal = result.status === 'failed' || result.status === 'refunded';
        if (terminal) {
          throw new SettlementFailedError({ paymentId: result.payment_id, state: result.status! });
        }
        throw new SettlementPendingError({
          paymentId: result.payment_id,
          state: result.status,
          detail: missingPayoutDetail(result),
        });
      }
      return {
        method: METHOD_NAME,
        status: 'success',
        timestamp: new Date(now()).toISOString(),
        reference: settled.hash,
        paymentId: settled.paymentId,
        state: settled.state,
        destinationChainId: settled.chainId,
      };
    },
  }) as AtumEscrowServer;
}

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
 * Says so when the gateway reports the payout made but no payout reached the SDK. The buyer reads
 * this, so it names no cause: a submitter that drops `transactions` and a gateway fault look the same
 * here. The buyer is still told to wait: reporting the payment failed would invite a second charge.
 */
function missingPayoutDetail(result: PaymentSubmitResult): string | undefined {
  if (!result.payment_id) return undefined;
  if (result.status !== 'completed' && result.status !== 'finalizing') return undefined;
  const payout = result.transactions?.fulfillment;
  if (payout?.transaction_hash && payout.chain_id) return undefined;
  return `The payment is ${result.status}, but its payout is not reported yet`;
}

/* ─────────────────────── Charge-request construction (merchant) ─────────────────────── */

/**
 * Validate a corridor's shape and per-source addresses. Run automatically by
 * {@link buildChargeRequest}; call it directly to fail fast at merchant startup.
 *
 * @throws {@link AtumEscrowConfigError} `INVALID_CONFIG` if the deadline budgets are
 *   non-positive or out of order, the markup is negative, there are no sources, a source is
 *   missing a required field, or a token's `symbol` or `decimals` is missing or invalid;
 *   `ASSETS_NOT_COMPARABLE` if a source token is not the same money as the destination token.
 */
export function validateCorridor(corridor: AtumEscrowCorridor): void {
  if (!Number.isFinite(corridor.quoteDeadlineSeconds) || corridor.quoteDeadlineSeconds <= 0) {
    throw invalidConfig('atum-escrow: quoteDeadlineSeconds must be a positive number of seconds');
  }
  if (
    !Number.isFinite(corridor.fulfillmentDeadlineSeconds) ||
    corridor.fulfillmentDeadlineSeconds <= 0
  ) {
    throw invalidConfig(
      'atum-escrow: fulfillmentDeadlineSeconds must be a positive number of seconds',
    );
  }
  if (corridor.quoteDeadlineSeconds >= corridor.fulfillmentDeadlineSeconds) {
    throw invalidConfig(
      'atum-escrow: quoteDeadlineSeconds must be strictly less than fulfillmentDeadlineSeconds',
    );
  }
  if (!Number.isFinite(corridor.markupBps) || corridor.markupBps < 0) {
    throw invalidConfig('atum-escrow: markupBps must be a non-negative number of basis points');
  }
  if (!Number.isInteger(corridor.markupBps)) {
    throw invalidConfig(
      `atum-escrow: markupBps must be a whole number of basis points, got ${corridor.markupBps}`,
    );
  }
  if (!corridor.sources || corridor.sources.length === 0) {
    throw invalidConfig('atum-escrow: corridor must configure at least one source');
  }
  // Typed as required, but configs arrive as JSON: guard the container before reading its fields.
  const declared: unknown = corridor.destination;
  if (typeof declared !== 'object' || declared === null) {
    throw invalidConfig(
      'atum-escrow: destination must be an object { network, asset, account, symbol, decimals }',
    );
  }
  const destination = corridor.destination;
  // The builders pick the destination chain's amount limit from this value.
  if (typeof destination.network !== 'string' || destination.network === '') {
    throw invalidConfig('atum-escrow: destination.network must be a non-empty CAIP-2 chain id');
  }
  assertTokenMetadata(destination, 'destination');
  if (corridor.pegGroups !== undefined && !isPegGroups(corridor.pegGroups)) {
    // A flat list would otherwise be read group by group as strings, and `includes` on a
    // string is a substring test: 'USD' would count as the same money as 'USDC'.
    throw invalidConfig(
      'atum-escrow: pegGroups must be an array of groups, each an array of non-empty symbols',
    );
  }
  const pegGroups = corridor.pegGroups ?? DEFAULT_PEG_GROUPS;
  // `entries()` visits holes, which `forEach` skips: a sparse list must fail here, not at the first
  // charge.
  for (const [i, src] of corridor.sources.entries()) {
    for (const field of [
      'network',
      'escrow',
      'reserver',
      'releaser',
      'fulfillmentVerifierEndpoint',
    ] as const) {
      if (!src[field]) {
        throw invalidConfig(`atum-escrow: source ${src.network ?? '?'} is missing '${field}'`);
      }
    }
    const versions = src.depositRequestHashVersions;
    if (
      versions !== undefined &&
      (versions.length === 0 ||
        versions.some((v) => !Number.isInteger(v) || v < 1) ||
        new Set(versions).size !== versions.length)
    ) {
      throw invalidConfig(
        `atum-escrow: source ${src.network} depositRequestHashVersions must list distinct positive integers`,
      );
    }
    const noAsset = (): AtumEscrowConfigError =>
      invalidConfig(
        `atum-escrow: source ${src.network} must list at least one non-empty asset in 'assets'`,
      );
    if (!src.assets || src.assets.length === 0) throw noAsset();
    src.assets.forEach((asset: unknown, j) => {
      if (typeof asset !== 'object' || asset === null) {
        throw invalidConfig(
          `atum-escrow: sources[${i}].assets[${j}] must be an object { address, symbol, decimals }, got ${renderValue(asset)}`,
        );
      }
    });
    if (src.assets.some((a) => typeof a.address !== 'string' || a.address === '')) {
      throw noAsset();
    }
    src.assets.forEach((asset, j) => {
      assertTokenMetadata(asset, `sources[${i}].assets[${j}]`);
      if (!comparable(asset.symbol, destination.symbol, pegGroups)) {
        throw new AtumEscrowConfigError({
          code: 'ASSETS_NOT_COMPARABLE',
          network: src.network,
          message: `atum-escrow: source ${asset.symbol} on ${src.network} is not the same money as destination ${destination.symbol} on ${destination.network}, so payers would refuse to price it`,
        });
      }
    });
    if (namespaceOf(src.network) === 'tron') {
      // Resolve now so an unmapped Tron network fails at startup, not when a payer first
      // tries to pay (the Permit2 address is fixed per-network, never carried on the wire).
      try {
        resolveTronPermit2(src.network);
      } catch (err) {
        throw invalidConfig(err instanceof Error ? err.message : String(err), err);
      }
    }
    if (namespaceOf(src.network) === 'solana') {
      if (!src.svmSignatureClusterId || src.svmSignatureDomainVersion == null) {
        throw invalidConfig(
          `atum-escrow: Solana source ${src.network} requires svmSignatureClusterId and svmSignatureDomainVersion`,
        );
      }
      // See SOLANA_MAX_FULFILLMENT_DEADLINE_SECONDS. The budget is shared by the corridor, so
      // split corridors if an EVM/Tron source needs a longer one.
      if (corridor.fulfillmentDeadlineSeconds > SOLANA_MAX_FULFILLMENT_DEADLINE_SECONDS) {
        throw invalidConfig(
          `atum-escrow: a corridor with a Solana source must set fulfillmentDeadlineSeconds <= ` +
            `${SOLANA_MAX_FULFILLMENT_DEADLINE_SECONDS} (Solana deposits expire within the escrow ` +
            `replay window); got ${corridor.fulfillmentDeadlineSeconds}`,
        );
      }
    }
  }
}

function assertTokenMetadata(token: { symbol: unknown; decimals: unknown }, path: string): void {
  if (typeof token.symbol !== 'string' || token.symbol === '') {
    throw invalidConfig(`atum-escrow: ${path}.symbol must be a non-empty string`);
  }
  if (!isTokenDecimals(token.decimals)) {
    throw invalidConfig(
      `atum-escrow: ${path}.decimals must be an integer from 0 to ${MAX_TOKEN_DECIMALS}, got ${renderValue(token.decimals)}`,
    );
  }
}

/**
 * Build the `charge` challenge request for a specific source option from a corridor — the
 * payment terms alone. The source cap is `fulfillmentAmount` plus `markupBps`, converted from the
 * destination token's atomic units to the selected source token's and rounded down to a whole
 * unit: `floor(F × (10000 + markupBps) × 10^sourceDecimals / (10000 × 10^destinationDecimals))`.
 * The corridor is validated first, so a misconfiguration fails here rather than at signing time.
 *
 * Prefer {@link buildChargeChallenge}, which pairs these terms with the per-purchase identifier
 * the payer requires. A challenge built from this function alone carries no such identifier, and
 * the payer's client refuses it at signing time. Use it directly only when supplying the
 * per-purchase metadata yourself.
 *
 * @param corridor - the corridor to serve.
 * @param select - which configured source to fund from, by `(network, asset)`.
 * @param fulfillmentAmount - exact amount the merchant receives, atomic units of the
 *   destination token. Set per charge so one registration serves any price.
 * @param options.issuedAt - Solana-source only: the merchant's cluster-clock reading (epoch
 *   seconds) to stamp into `extra.issuedAt`, so the payer's client builds the deposit fully
 *   offline (no RPC). Omit to let the client stamp `issued_at` at signing time, which keeps the
 *   full replay window; a merchant-stamped value starts the window at 402-build time.
 *   Ignored for EVM/Tron sources.
 * @throws {@link AtumEscrowConfigError} for an invalid corridor (see {@link validateCorridor}),
 *   `INVALID_AMOUNT` for a `fulfillmentAmount` that is not a plain base-10 integer, or
 *   `CAP_BELOW_PRICE` when the rounded cap is worth less than the fulfillment (a price below one
 *   atomic unit of a source token with fewer decimals), or `AMOUNT_EXCEEDS_CHAIN_LIMIT` when the
 *   fulfillment exceeds what the destination chain's amount type holds or the cap exceeds the
 *   source chain's (uint256 on EVM and Tron, u64 on Solana); and if no source option matches
 *   `select`.
 */
export function buildChargeRequest(
  corridor: AtumEscrowCorridor,
  select: { network: string; asset: string },
  fulfillmentAmount: string,
  options?: { issuedAt?: string },
): ChargeRequest {
  validateCorridor(corridor);
  if (typeof fulfillmentAmount !== 'string' || !/^[0-9]+$/.test(fulfillmentAmount)) {
    throw new AtumEscrowConfigError({
      code: 'INVALID_AMOUNT',
      message: `atum-escrow: fulfillmentAmount must be a non-negative base-10 integer in the destination token's atomic units, got ${renderValue(fulfillmentAmount)}`,
    });
  }
  assertWithinChainLimit(
    BigInt(fulfillmentAmount),
    corridor.destination.network,
    'fulfillmentAmount',
  );
  const src = corridor.sources.find(
    (s) =>
      s.network === select.network && s.assets.some((a) => sameAddress(a.address, select.asset)),
  );
  if (!src) {
    throw new Error(
      `atum-escrow: no source option configured for ${select.network} / ${select.asset}`,
    );
  }
  // Emit the merchant's canonical stored form of the selected token (case-preserving),
  // so the wire challenge matches what the source configured.
  const asset = src.assets.find((a) => sameAddress(a.address, select.asset))!;
  const selectedAsset = asset.address;
  const destinationDecimals = corridor.destination.decimals;
  const cap = maxSourceAmount({
    fulfillmentAmount,
    markupBps: corridor.markupBps,
    sourceDecimals: asset.decimals,
    destinationDecimals,
  });
  assertWithinChainLimit(cap, src.network, `the source.amount cap for ${src.network}`);
  // Rounding down protects the payer, but with fewer source than destination decimals it can
  // land below the price itself, and a cap no settler can fill fails the payment.
  if (
    cap * 10n ** BigInt(destinationDecimals) <
    BigInt(fulfillmentAmount) * 10n ** BigInt(asset.decimals)
  ) {
    throw new AtumEscrowConfigError({
      code: 'CAP_BELOW_PRICE',
      network: src.network,
      message: `atum-escrow: the cap for source ${src.network} rounds to ${cap} atomic units of ${asset.symbol}, worth less than the fulfillment of ${fulfillmentAmount} atomic units of ${corridor.destination.symbol}`,
    });
  }
  const isSolana = namespaceOf(src.network) === 'solana';
  // A merchant-supplied issuedAt is stamped into the Solana deposit's `issued_at`, which the
  // payer's client feeds to BigInt(). Reject a non-numeric value here so a misconfiguration
  // fails at 402-build with a clear error, not opaquely in the payer's credential build.
  if (isSolana && options?.issuedAt !== undefined && !/^[0-9]+$/.test(options.issuedAt)) {
    throw new Error(
      `atum-escrow: issuedAt must be epoch seconds (digits only), got '${options.issuedAt}'`,
    );
  }
  return {
    source: {
      network: src.network,
      asset: selectedAsset,
      amount: cap.toString(),
    },
    extra: {
      // The corridor config carries the receive side as `account`; the wire `extra` names it
      // `address` (the x402 scheme field), so map it here.
      destination: {
        network: corridor.destination.network,
        asset: corridor.destination.asset,
        address: corridor.destination.account,
      },
      fulfillmentAmount,
      escrow: src.escrow,
      fulfillmentProxy: corridor.fulfillmentProxy,
      reserver: src.reserver,
      releaser: src.releaser,
      fulfillmentVerifierEndpoint: src.fulfillmentVerifierEndpoint,
      quoteDeadlineSeconds: corridor.quoteDeadlineSeconds,
      fulfillmentDeadlineSeconds: corridor.fulfillmentDeadlineSeconds,
      ...(src.svmSignatureClusterId ? { svmSignatureClusterId: src.svmSignatureClusterId } : {}),
      ...(src.svmSignatureDomainVersion != null
        ? { svmSignatureDomainVersion: src.svmSignatureDomainVersion }
        : {}),
      ...(isSolana && options?.issuedAt ? { issuedAt: options.issuedAt } : {}),
      ...(src.depositRequestHashVersions !== undefined
        ? {
            depositRequestHashVersions: [...src.depositRequestHashVersions] as [
              number,
              ...number[],
            ],
          }
        : {}),
    },
  };
}

/**
 * A charge challenge's two halves, ready to hand to the framework.
 *
 * `request` is the method-specific payment terms and `meta` is challenge metadata, matching the
 * framework's shape. Both are covered by the challenge-id HMAC.
 */
export interface ChargeChallenge {
  /** The method-specific charge request (the payment terms). */
  request: ChargeRequest;
  /** Challenge metadata carrying the per-intent identifier. */
  meta: Record<string, string>;
}

/**
 * Build a charge challenge for a specific source option from a corridor.
 *
 * This is the entry point a merchant should use: it pairs the payment terms with the per-purchase
 * identifier the payer needs to make the payment retry-safe. A challenge built without that
 * identifier is refused by the payer's client rather than paid unsafely.
 *
 * Pass the result straight through to the framework:
 *
 * ```ts
 * const { request, meta } = buildChargeChallenge(corridor, source, amount, { intentId: order.id })
 *
 * // Route-handler style:
 * mppx.compose(['atum-escrow/charge', { ...request, meta }])(input)
 *
 * // Or building the challenge directly:
 * Challenge.fromMethod(atumEscrowChargeMethod, { request, meta, realm, secretKey })
 * ```
 *
 * @param corridor - the corridor to serve.
 * @param select - which configured source to fund from, by `(network, asset)`.
 * @param fulfillmentAmount - exact amount the merchant receives, atomic units of the
 *   destination token.
 * @param options.intentId - identifies the thing being bought. Use the merchant's own order,
 *   invoice, or cart identifier: one value per purchase, the SAME value every time that purchase
 *   is re-offered or retried, and never shared between two purchases. The payer derives the
 *   payment's identity from it and the gateway de-duplicates on that, so its lifetime is what
 *   decides whether a retry is recognized (a value that changes per attempt causes a second
 *   charge) and whether two purchases stay distinct (a value shared between them leaves the
 *   second unpaid). Do not derive it from the terms: two orders for the same item have identical
 *   terms.
 * @param options.issuedAt - Solana-source only; see {@link buildChargeRequest}.
 * @throws if `intentId` is empty, or anything {@link buildChargeRequest} throws (an invalid
 *   corridor, `INVALID_AMOUNT`, `CAP_BELOW_PRICE`, `AMOUNT_EXCEEDS_CHAIN_LIMIT`, or no matching
 *   source option).
 */
export function buildChargeChallenge(
  corridor: AtumEscrowCorridor,
  select: { network: string; asset: string },
  fulfillmentAmount: string,
  options: { intentId: string; issuedAt?: string },
): ChargeChallenge {
  if (typeof options.intentId !== 'string' || options.intentId === '') {
    throw new Error(
      'atum-escrow: intentId must be a non-empty per-purchase identifier (e.g. an order id); ' +
        "the payer derives the payment's identity from it, so without one a retry would be " +
        'charged as a second payment',
    );
  }
  return {
    request: buildChargeRequest(corridor, select, fulfillmentAmount, options),
    meta: { [INTENT_ID_META_KEY]: options.intentId },
  };
}

/**
 * The versions a corridor source lists, from its chain's defaults: what the gateway lists, exactly
 * as it lists them, except that `[1]` lists nothing, which payers read as `[1]`. A list this build
 * cannot publish is `INVALID_CONFIG`.
 */
function publishedVersions(
  network: string,
  defaults: ChainDefaults,
): Pick<AtumEscrowSource, 'depositRequestHashVersions'> {
  let versions: number[] | undefined;
  try {
    versions = publishedDepositRequestHashVersions(defaults);
  } catch (err) {
    throw invalidConfig(
      `atum-escrow: the gateway's depositRequestHash versions for ${network} cannot be published: ${(err as Error).message}`,
      err,
    );
  }
  return versions === undefined ? {} : { depositRequestHashVersions: versions };
}

/** The minimal defaults source `corridorFromDefaults` needs; satisfied by the gateway client. */
export interface ChainDefaultsSource {
  fetchChainDefaults(chainId: string): Promise<ChainDefaults>;
}

/**
 * Build a corridor by fetching the escrow/role/proxy addresses from the payment gateway's
 * `/defaults` endpoint, so the merchant does not hand-author protocol addresses. Fetches
 * the destination chain's fulfillment proxy and each source chain's escrow, reserver,
 * releaser, verifier endpoint (and Solana domain fields) in parallel.
 *
 * Token `symbol` and `decimals` are not fetched: they are declared here, for the destination and
 * every source asset, and copied onto the corridor unchanged. Take them from the `tokens` the
 * same `GET /v1/defaults` lists for each chain, which is what payers price against.
 *
 * @param defaults - a defaults source (e.g. a `PaymentGatewayClient`).
 * @param params - the destination receive-side, the source chains and their accepted
 *   token `assets`, the markup, the deadline budgets and, optionally, the peg groups. One entry
 *   per source chain; list several tokens in `assets` to accept more than one on that chain.
 */
export async function corridorFromDefaults(
  defaults: ChainDefaultsSource,
  params: {
    destination: AtumEscrowCorridor['destination'];
    sources: ReadonlyArray<{ network: string; assets: ReadonlyArray<AtumEscrowAsset> }>;
    markupBps: number;
    quoteDeadlineSeconds: number;
    fulfillmentDeadlineSeconds: number;
    pegGroups?: ReadonlyArray<ReadonlyArray<string>>;
  },
): Promise<AtumEscrowCorridor> {
  const [destDefaults, ...sourceDefaults] = await Promise.all([
    defaults.fetchChainDefaults(params.destination.network),
    ...params.sources.map((s) => defaults.fetchChainDefaults(s.network)),
  ]);
  const sources: AtumEscrowSource[] = params.sources.map((s, i) => {
    const d = sourceDefaults[i]!;
    return {
      network: s.network,
      assets: s.assets,
      escrow: d.escrowContract,
      reserver: d.quoteSelector,
      releaser: d.fulfillmentVerifierAccount,
      fulfillmentVerifierEndpoint: d.fulfillmentVerifierEndpoint,
      ...(d.svmSignatureClusterId ? { svmSignatureClusterId: d.svmSignatureClusterId } : {}),
      ...(d.svmSignatureDomainVersion != null
        ? { svmSignatureDomainVersion: d.svmSignatureDomainVersion }
        : {}),
      ...publishedVersions(s.network, d),
    };
  });
  return {
    destination: params.destination,
    fulfillmentProxy: destDefaults.fulfillmentProxy,
    markupBps: params.markupBps,
    quoteDeadlineSeconds: params.quoteDeadlineSeconds,
    fulfillmentDeadlineSeconds: params.fulfillmentDeadlineSeconds,
    sources,
    ...(params.pegGroups !== undefined ? { pegGroups: params.pegGroups } : {}),
  };
}
