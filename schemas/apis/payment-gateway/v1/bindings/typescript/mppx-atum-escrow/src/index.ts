/*
 * Copyright 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Atum cross-chain escrow payment method for the Machine Payments Protocol (MPP).
 *
 * Register this method on both sides of an `mppx` integration to accept the `charge`
 * intent through Atum. The payer funds the payment in any supported source asset and
 * chain; the merchant pins the asset, chain, and exact amount it receives. The method
 * builds and signs the payment on the client, verifies and settles it on the server,
 * and returns an MPP receipt once the payout is on chain.
 *
 * The source-chain authorization is built and signed through the Atum payment-gateway
 * client, so a single code path supports EVM, Tron, and Solana sources.
 *
 * This root barrel re-exports the whole public API. Integrations can also import the
 * side they need directly — `@atumlabs/mppx-atum-escrow/client` (payer) or
 * `@atumlabs/mppx-atum-escrow/server` (merchant) — which pull in only that side's code.
 *
 * @example Merchant (server)
 * ```ts
 * import { Mppx } from 'mppx/server'
 * import { registerServer } from '@atumlabs/mppx-atum-escrow/server'
 *
 * const method = registerServer({ submitter })
 * const mppx = Mppx.create({ realm: 'api.example.com', secretKey, methods: [method] })
 * ```
 *
 * @example Payer (client)
 * ```ts
 * import { registerClient } from '@atumlabs/mppx-atum-escrow/client'
 *
 * const method = registerClient({ signer: { privateKey }, account: '0x…' })
 * // register `method` into your mppx client
 * ```
 *
 * @packageDocumentation
 */

// Shared building blocks (method definition, wire schemas, constants, shared types).
export {
  METHOD_NAME,
  INTENT,
  INTENT_ID_META_KEY,
  ChargeRequestSchema,
  CredentialPayloadSchema,
  atumEscrowChargeMethod,
} from './internal.js';
export type {
  ChargeRequest,
  ChargeCredentialPayload,
  AtumEscrowChallenge,
  AtumEscrowCredential,
  PaymentRequest,
  AtumEscrowExtra,
  AtumEscrowRequest,
} from './internal.js';

// Payer (client) side.
export {
  registerClient,
  ensureSourceApproval,
  needsSourceApproval,
  isUnconfirmed,
  AtumEscrowTrustError,
  ATUM_DEFAULT_TRUST_GATEWAYS,
  atumGatewayTrust,
  DEFAULT_MAX_MARKUP_BPS,
  DEFAULT_PEG_GROUPS,
} from './client.js';
export type {
  ApprovalParams,
  AtumEscrowClientConfig,
  AtumEscrowTrustErrorCode,
  AtumGatewayTrustOptions,
  ConfirmationOptions,
  EnsureApprovalResult,
  SenderSigner,
  SenderSignerOptions,
  TronWebLike,
  TrustResolver,
  TrustedRoles,
  TrustedToken,
} from './client.js';

// Merchant (server) side.
export {
  registerServer,
  validateCorridor,
  buildChargeChallenge,
  buildChargeRequest,
  corridorFromDefaults,
  AtumEscrowConfigError,
} from './server.js';
export type {
  AtumEscrowServer,
  AtumEscrowServerConfig,
  AtumEscrowCorridor,
  AtumEscrowSource,
  AtumEscrowAsset,
  AtumEscrowConfigErrorCode,
  ChainDefaultsSource,
  ChargeChallenge,
  PaymentSubmitter,
  PaymentSubmitContext,
  PaymentSubmitResult,
  DepositRequestHashShadow,
  PaymentSettlementStatus,
  PaymentTransactionView,
  PaymentTransactionsView,
  SettleAt,
  AtumEscrowReceipt,
  CommitmentResult,
  CommitmentOutcome,
} from './server.js';

// Settlement outcomes that are not a receipt (pending vs terminally failed vs refused, for good
// or for now).
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
} from './errors.js';
export type { SettlementErrorDetails } from './errors.js';
