/**
 * Payment Gateway TypeScript Client
 *
 * Main entry point that combines auto-generated API client code with
 * manually-crafted utilities for the Atum payment gateway.
 */

// Import the generated client for extension
import { PaymentGatewayClient as GeneratedPaymentGatewayClient } from './generated/PaymentGatewayClient';
import type { OpenAPIConfig } from './generated/core/OpenAPI';
import { OpenAPI as GeneratedOpenAPI, Interceptors } from './generated/core/OpenAPI';
import type { AxiosRequestConfig } from 'axios';
import type { BaseHttpRequest } from './generated/core/BaseHttpRequest';
import { $PreparePaymentRequest } from './generated/schemas.gen';
import { type RequestTimeouts } from './request-timeout';
import { timeoutHttpRequest, withRequestTimeout } from './timeout-http-request';
import { ShadowingPaymentsService } from './payment-shadow';
// Aliased because the public `ChainDefaults` (from ./chain-adapters) shadows it: the generated
// type is the snake_case wire shape, the public one the flat camelCase shape callers pass in.
import type {
  AwardedQuote,
  AwardRequest,
  ChainDefaults as ChainDefaultsWire,
  CreateQuoteRequest,
  GetDefaultsResponse,
  PaymentRequest,
  PaymentResponse,
  Quote,
  SenderAuthMessageScheme,
} from './generated/types.gen';
import { readAwardInputs, sameAccount, signAward } from './award-quote';
import { isApiError, isGatewayTimeoutError } from './errors';
import type { ChainDefaults } from './chain-adapters';
import { getChainAdapter } from './chain-adapters';
import { assetChainId, parseAssetIdentifier } from './asset-identifier';
import { validate as validateChainAccount } from '@atum-labs/chain-address';
import type { SolanaClusterUnixTimeReader } from './chain-adapters/solana-clock';
import { resolveSolanaIssuedAt } from './chain-adapters/solana-clock';
import type { StellarLedgerCloseTimeReader } from './chain-adapters/stellar-clock';
import { resolveStellarIssuedAt } from './chain-adapters/stellar-clock';
import type {
  StellarDelegateEpochReader,
  StellarDelegateRecordReader,
} from './chain-adapters/stellar-delegate';
import {
  assertStellarDelegateUsable,
  resolveStellarDelegate,
} from './chain-adapters/stellar-delegate';
import { resolveMaxSourceAmount } from './max-source-amount';
import {
  assertDirectDepositFulfillmentAmount,
  assertDirectDepositHashVersion,
  assertDirectDepositRequestId,
  assertOrderedDeadlines,
  assertDirectDepositWindows,
  assertEvmAccount,
  assertSettlerRequirements,
  assertVerifierEndpoint,
  buildDirectDepositRequest,
  directDepositAmount,
  directDepositNonce,
  directDepositSourceChainId,
  directDepositV1Deprecation,
  reportDirectDepositDeprecation,
  resolveDirectDepositHashVersion,
  type DirectDepositDeprecation,
  type DirectDepositFulfill,
  type DirectDepositPaymentRequest,
  type SettlerRequirements,
} from './direct-deposit-request';
import type { SenderSigner } from './signers';
import { defaultGateway as generatedDefaultGateway } from './hosts.generated';
// sender_auth messages are built by the shared SDK; this package's own adapters handle only
// contract-field normalization (Tron base58 -> hex) and key handling.
import {
  getChainAdapter as getSenderAuthAdapter,
  deterministicPermitNonce,
  deterministicSolanaNonce,
  depositRequestHashVersionsOf,
  deriveDirectDeposit,
  deterministicStellarNonce,
  assertStellarSignable,
  REQUEST_ID_PATTERN,
  type DirectDeposit,
} from '@atum-labs/payment-request-sender-auth';

// Declaration version every producer emits. The bindings constant is the source
// of truth and already includes the executor field (1.3).
import { VERSION as PAYMENT_REQUEST_VERSION } from '@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript/version';
export { PAYMENT_REQUEST_VERSION };

// The shared PaymentRequest rules, the same ones the gateway and the settlers apply. A direct
// deposit is checked against them before it is returned, because the gateway would otherwise
// refuse it only after the payer funded.
import { validatePaymentRequestJSON } from '@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript/validate';
export {
  PaymentRequestError,
  UnsupportedDestinationAssetError,
  DirectDepositRuleError,
  type DirectDepositRule,
} from '@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript/validate';
// deriveDirectDeposit re-derives a prepared deposit from the request as stored, for a payer that
// kept the request JSON rather than the returned deposit (which holds bigints), at the
// depositRequestHashVersion prepareDirectDepositRequest returned with it.
export {
  deriveDirectDeposit,
  type DirectDeposit,
  type DerivedDirectDepositInput,
  type DirectDepositReason,
} from '@atum-labs/payment-request-sender-auth';
// The error both deriveDirectDeposit and prepareDirectDepositRequest throw, typed with the reasons
// only the latter reports alongside the derivation's.
export { DirectDepositError, type DirectDepositClientReason } from './direct-deposit-request';
// The calldata of escrow.directDeposit for a prepared deposit's `input`, for a wallet that
// assembles its own funding transactions (approve the escrow for `input.amount` first).
export { encodeDirectDepositCalldata } from '@atum-labs/evm-escrow-encoding';
export type {
  DirectDepositDeprecation,
  DirectDepositFulfill,
  DirectDepositPaymentRequest,
  SettlerRequirements,
} from './direct-deposit-request';

// Re-export all auto-generated code except the client we're extending
export * from './generated/types.gen';
export { parseAssetIdentifier, assetChainId } from './asset-identifier';
export type { ParsedAssetIdentifier } from './asset-identifier';
export { capFromQuote } from './cap-from-quote';
export {
  sdkPaymentShadow,
  submitPaymentShadow,
  type DepositRequestHashShadow,
} from './payment-shadow';
// Thrown by the receiver pre-flight; exported so callers can use `instanceof` and read the typed
// `reason` rather than matching on message text.
export { InvalidAccountError, type Reason as InvalidAccountReason } from '@atum-labs/chain-address';
export * from './generated/services.gen';
export * from './generated/schemas.gen';
export { ApiError } from './generated/core/ApiError';
// Typed accessors for the public gateway error. `ErrorResponse` itself is
// re-exported above via ./generated/types.gen.
export { getErrorResponse, isApiError, GatewayTimeoutError, isGatewayTimeoutError } from './errors';

// The signing functions live at the `/signing` subpath so the JSON-LD dependencies they pull in
// (jsonld, rdf-canonize, canonicalize) are opt-in:
//
//   import { signDeclaration } from '@atum-labs/payment-gateway-client/signing';
//
// See docs/signing.md.
export type {
  VerifyResult,
  VerifyPaymentRequestExpectations,
  VerifiedSenderAuth,
  ParsedPermit,
  AuthTerms,
  CommitmentOutcome,
  CommitmentResult,
  SolanaDomain,
} from './sender-auth-verify';
export * from './generated/core/ApiRequestOptions';
export * from './generated/core/ApiResult';
export * from './generated/core/CancelablePromise';
// ./generated/core/OpenAPI is re-exported member-by-member rather than with
// `export *` so this package owns the advertised default BASE. See the `OpenAPI`
// export below (declared after `defaultGateway`, which it reads).
export type { OpenAPIConfig } from './generated/core/OpenAPI';
export { Interceptors } from './generated/core/OpenAPI';

// The budgets and their error, so a consumer can detect a timeout and widen it.
// The classification and transport plumbing stays internal.
export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SYNC_WAIT_TIMEOUT_MS,
  type RequestTimeouts,
} from './request-timeout';

// Waiting for a submitted payment to reach a terminal state (also backs the CLI's `--wait`).
// `isTerminalStatus` is the single definition of which states are final.
export {
  waitForStatus,
  waitForTerminalStatus,
  isTerminalStatus,
  DEFAULT_WAIT_BUDGET_MS,
  DEFAULT_POLL_INTERVAL_MS,
  type StatusSnapshot,
  type WaitOutcome,
  type WaitParams,
  type WaitFor,
} from './payment-tracking';

// The chain adapters and sender-auth message construction are internal and may change between
// releases. Build a signable request with {@link PaymentGatewayClient.preparePaymentRequest}
// and sign it with {@link signPaymentRequest}. `ChainDefaults` is the data shape that entry
// point accepts.
export type { ChainDefaults } from './chain-adapters';
// The generated wire shape returned by `client.chainDefaults.getDefaults()`, aliased because
// the public `ChainDefaults` above shadows it in the generated-types star export.
export type { ChainDefaults as ChainDefaultsWire } from './generated/types.gen';

// Lets an offline caller inject the `issued_at` a Solana deposit is stamped with (the default
// reader queries an RPC endpoint).
export type { SolanaClusterUnixTimeReader } from './chain-adapters/solana-clock';
// The same for a Stellar deposit, whose `issued_at` is the latest closed ledger's close time.
export type { StellarLedgerCloseTimeReader } from './chain-adapters/stellar-clock';
// And for the epoch of the payer's on-chain delegate record, which a Stellar deposit commits to, or
// the whole record, whose signer, expiration and capacity decide whether the escrow accepts it.
export type {
  StellarDelegateEpochReader,
  StellarDelegateRecordReader,
  StellarDelegateRecord,
  StellarStoredDelegateRecord,
  StellarDelegateQuery,
} from './chain-adapters/stellar-delegate';
// A Stellar payer's one-time setup: the delegate record and the token allowance.
export { createStellarDelegate, StellarDelegateSetupError } from './stellar-delegate-setup';
export type {
  CreateStellarDelegateParams,
  CreateStellarDelegateResult,
  FinishStellarDelegateApprovalParams,
  FinishStellarDelegateApprovalResult,
  StellarCallArg,
  StellarContractCall,
  StellarLedgerHead,
  StellarSetupChain,
} from './stellar-delegate-setup';

// Permit2 source-token approval. This is the only part of the client that sends a transaction;
// the caller supplies the connected signer (an ethers signer for EVM, a TronWeb instance for
// Tron). Solana authorizes the transfer inside the signed deposit and needs no approval. Without
// the approval, a payment is accepted but reverts on-chain at settlement.
//
// `isUnconfirmed` distinguishes an approval that was broadcast but not yet seen within the wait
// budget from one that failed, so a caller does not send a second approval.
export {
  ensureSourceApproval,
  needsSourceApproval,
  isUnconfirmed,
} from '@atum-labs/payment-request-token-approval';
export type {
  ApprovalParams,
  ConfirmationOptions,
  EnsureApprovalResult,
  TronWebLike,
} from '@atum-labs/payment-request-token-approval';

// Re-export permit2 utilities
export {
  hashPermitWitnessTransferFrom,
  PERMIT2_CONTRACT_ADDRESS,
} from './sender_auth_schemes/evm_permit2';

// Re-export Tron utilities
export {
  base58ToHex,
  normalizeAddress,
  maskChainId,
  hashTvmPermitWitnessTransferFrom,
} from './sender_auth_schemes/tron';

// Re-export Solana utilities
export {
  generateSolanaNonce,
  encodeU64LE,
  base58ToBytes,
  bytesToHex,
  hexToBytes,
  REPLAY_HORIZON_SECS,
  MAX_VALID_SLOT,
  TOTAL_BUCKETS,
} from './sender_auth_schemes/solana';

// Re-export Stellar utilities
export {
  deterministicStellarNonce,
  generateStellarNonce,
  STELLAR_MAX_DEPOSIT_VALIDITY_SECS,
} from './sender_auth_schemes/stellar';

// Sign the sender_auth message with a local private key (default) or a Turnkey wallet.
export { createSenderSigner, resolveTurnkeyAddresses, TurnkeySenderSigner } from './signers';
export type { SenderSigner, SenderSignature, SenderSignerOptions, TurnkeyConfig } from './signers';

/**
 * Refuses a request whose Stellar messages are not deposits, before any key signs them. A Stellar
 * key signs 32 bytes with plain ed25519, which is also how a Stellar transaction is signed (over its
 * hash), so a `message` the requester set to a transaction hash would get the payer's key's
 * transaction signature. Each message must be the deposit digest of its own `message_prehash` under
 * the request's source network and escrow.
 *
 * It runs when the request's source is a `stellar:` network or the signer is bound to one, so a
 * request that calls itself an EVM payment cannot be given to a Stellar key. A signer bound to a
 * network refuses a request from another. Other requests are not checked here.
 * {@link signPaymentRequest} and `send-payment` run it; a caller that signs with its own signer
 * outside them runs it first.
 *
 * @throws If a Stellar message is not the deposit digest of its prehash, or the signer's network is
 * not the request's source network.
 */
export function assertRequestSignable(request: PaymentRequest, signer: SenderSigner): void {
  const sourceAsset = request.source?.asset_identifier;
  const requestNetwork = typeof sourceAsset === 'string' ? sourceAsset.split('/')[0] : undefined;
  const isStellar = (network: string | undefined) => network?.toLowerCase().startsWith('stellar:');
  const signerNetwork = signer.network;
  if (!isStellar(requestNetwork) && !isStellar(signerNetwork)) return;
  if (
    signerNetwork !== undefined &&
    signerNetwork.toLowerCase() !== requestNetwork?.toLowerCase()
  ) {
    throw new Error(
      `signPaymentRequest: the signer is for ${signerNetwork} but the request's source is ${requestNetwork ?? 'missing'}: refusing to sign`,
    );
  }
  for (const signedMessage of request.sender_auth?.signed_messages ?? []) {
    assertStellarSignable(signedMessage, requestNetwork as string, request.escrow_contract_address);
  }
}

/**
 * Applies a SenderSigner to an unsigned PaymentRequest, signing every entry in
 * signed_messages as given (filling each signature, and payload.delegate_signer where the
 * chain requires it). The gateway verifies every signed message. To check what a request
 * commits to before signing it, see docs/signing.md. A Stellar request, or a Stellar key, is
 * first checked by {@link assertRequestSignable}: every message must be the deposit digest of its
 * own `message_prehash`, and nothing is signed otherwise.
 *
 * @throws If the request has no signed_messages, or {@link assertRequestSignable} refuses it.
 */
export async function signPaymentRequest(
  request: PaymentRequest,
  signer: SenderSigner,
): Promise<PaymentRequest> {
  if (!request.sender_auth?.signed_messages?.length) {
    throw new Error(
      'signPaymentRequest: request.sender_auth.signed_messages must contain at least one message to sign',
    );
  }
  assertRequestSignable(request, signer);
  for (const signedMessage of request.sender_auth.signed_messages) {
    const { signature, delegateSigner } = await signer.sign(signedMessage);
    signedMessage.signature = signature;
    if (delegateSigner) {
      signedMessage.payload = { ...(signedMessage.payload ?? {}), delegate_signer: delegateSigner };
    }
  }
  return request;
}

/**
 * Refuses a receiver its destination chain cannot pay, before anything is signed or submitted.
 *
 * Applies the gateway's ingress rules for account format, so a caller finds out here rather
 * than through a 400. Whether a given settler can pay the account is decided server side.
 */
function assertPayableAccount(assetIdentifier: string, account: string): void {
  validateChainAccount(assetChainId(assetIdentifier), account);
}

type HttpRequestConstructor = new (config: OpenAPIConfig) => BaseHttpRequest;

/**
 * Authorizes each gateway request: the headers to send for its method and URL.
 * `createSessionTokenSource` from the `./signing` entry returns one. With it, every
 * request carries the caller's session token, as `Authorization: DPoP` with a fresh
 * proof by the client's key when the token is bound to that key, or as
 * `Authorization: Bearer` when it is not.
 */
export interface SessionAuthorizer {
  /**
   * The headers for one request, or none to send it without a session. `url` is the
   * full request URL. Must not throw: a request without a session is still served.
   */
  authorize(method: string, url: string): Promise<Record<string, string>>;
}

/**
 * Request-layer configuration plus this package's network timeouts. Omit the
 * timeouts for the defaults; see {@link RequestTimeouts}.
 *
 * `session` sends a session token on every request (see {@link SessionAuthorizer}).
 * Use it rather than `TOKEN`: `TOKEN` can only send `Authorization: Bearer`, which a
 * token bound to a key is not accepted with.
 */
export type PaymentGatewayClientConfig = Partial<OpenAPIConfig> &
  RequestTimeouts & {
    session?: SessionAuthorizer;
  };

export const defaultGateway: string = generatedDefaultGateway;

/**
 * Default request-layer configuration, with `BASE` set to this package's default
 * gateway ({@link defaultGateway}, production-testnet).
 *
 * The OpenAPI contract's first `servers` entry is mainnet; this package defaults to testnet
 * so a client created without an explicit URL never targets a live-funds environment.
 *
 * Exported for callers that want the default configuration shape.
 * {@link PaymentGatewayClient} does not read it: the client resolves its own `BASE`.
 */
export const OpenAPI: OpenAPIConfig = { ...GeneratedOpenAPI, BASE: defaultGateway };

/**
 * Default quote-collection window for {@link PaymentGatewayClient.prepareQuoteRequest}
 * (`quote_deadline = now + this`, in seconds). Bidding closes at the quote deadline and the
 * gateway always waits until then, so the window is time every quote request spends. 3s
 * is enough for a settler that quotes from its own inventory and lets a sync (`?wait=true`)
 * request return `ready` with its quotes inline. A settler that must source the payout first,
 * such as through a swap, may need longer and declines a short window with
 * `QUOTE_WINDOW_TOO_SHORT`. A caller whose clock lags the gateway's should pass a larger
 * `quoteDeadlineSeconds`, since the gateway refuses a quote deadline already in its past.
 */
export const DEFAULT_QUOTE_DEADLINE_SECONDS = 3;

/**
 * Default fulfillment window for both request builders (`fulfillment_deadline = now + this`, in
 * seconds): 5 minutes. The fulfillment deadline is when the payout must be mined on the
 * destination chain; it does not have to be final by then. A longer deadline does not make a
 * successful payment slower, but a failed payment is refunded only after its deadline passes, so a
 * shorter one gives the payer's funds back sooner.
 *
 * Before paying out, a settler waits for the payer's deposit to be confirmed on the source chain,
 * and does not bid on a payment whose deadline that wait does not fit. 5 minutes fits that wait on
 * every supported source chain for everyday payment sizes. For a large payment a settler may wait
 * until the source chain finalizes the deposit, so pass a longer `fulfillmentDeadlineSeconds` (for
 * example 3600).
 *
 * The same value is the API description's default for `fulfillment_deadline_seconds`.
 */
export const DEFAULT_FULFILLMENT_DEADLINE_SECONDS =
  $PreparePaymentRequest.properties.fulfillment_deadline_seconds.default;

/**
 * Default `quote_deadline` the single-shot payment path ({@link PaymentGatewayClient.preparePaymentRequest})
 * stamps (seconds) when the caller passes no `quoteDeadlineSeconds`, whichever depositRequestHash
 * version the deposit signs. Unless the submit sets `autoAccept`, the gateway runs the auction
 * until this deadline before it awards a settler, so the window is time every payment spends. It
 * is stamped before the caller signs, so it has to cover signing and submitting the request as
 * well as settlers quoting; 3s fits a signer that answers in well under a second and a settler
 * that quotes from its own inventory. A settler that must source the payout first, such as
 * through a swap, may need longer and declines a short window with `QUOTE_WINDOW_TOO_SHORT`.
 * It is also how long a signed request stays submittable. Pass a larger `quoteDeadlineSeconds`
 * when signing takes longer (for example a signer that waits for an approval), to submit the
 * request later, or when the caller's clock lags the gateway's, and raise
 * `fulfillmentDeadlineSeconds` by the same amount: the quote window comes out of the
 * {@link DEFAULT_FULFILLMENT_DEADLINE_SECONDS | fulfillment window}, which settlers need after the
 * quote deadline to take the deposit and pay out.
 *
 * The same value is the API description's default for `quote_deadline_seconds`.
 */
export const DEFAULT_PAYMENT_QUOTE_DEADLINE_SECONDS =
  $PreparePaymentRequest.properties.quote_deadline_seconds.default;

/**
 * The depositRequestHash version a deposit from a chain with these defaults signs: v2 when the
 * gateway lists it, v1 otherwise.
 *
 * @throws If the gateway lists no version this build signs, so any deposit would be refused.
 */
function depositRequestHashVersionToSign(defaults: ChainDefaults): 1 | 2 {
  const versions = depositRequestHashVersionsOf(defaults);
  if (versions.includes(2)) return 2;
  if (versions.includes(1)) return 1;
  throw new Error(
    `payment-gateway-client: the gateway accepts depositRequestHash versions ${JSON.stringify(defaults.depositRequestHashVersions)} ` +
      'for this chain, none of which this build signs; upgrade @atum-labs/payment-gateway-client',
  );
}

/** The quote and fulfillment windows in seconds, with defaults applied and validated. */
interface DeadlineWindows {
  quoteDeadlineSeconds: number;
  fulfillmentDeadlineSeconds: number;
}

/**
 * Resolve the quote/fulfillment windows (applying defaults) and validate them. Shared by
 * preparePaymentRequest and prepareQuoteRequest, each of which passes its own default quote
 * window, and by prepareDirectDepositRequest, which requires both windows beforehand so no
 * default applies. Builders call it before any network read so a bad value fails fast, and turn
 * the windows into timestamps later with {@link stampDeadlines}.
 */
function resolveDeadlineWindows(
  params: { quoteDeadlineSeconds?: number; fulfillmentDeadlineSeconds?: number },
  defaultQuoteSeconds: number,
): DeadlineWindows {
  const quoteDeadlineSeconds = params.quoteDeadlineSeconds ?? defaultQuoteSeconds;
  const fulfillmentDeadlineSeconds =
    params.fulfillmentDeadlineSeconds ?? DEFAULT_FULFILLMENT_DEADLINE_SECONDS;
  if (!Number.isFinite(quoteDeadlineSeconds) || !Number.isFinite(fulfillmentDeadlineSeconds)) {
    throw new Error(
      'quoteDeadlineSeconds and fulfillmentDeadlineSeconds must be finite numbers of seconds.',
    );
  }
  if (quoteDeadlineSeconds <= 0 || fulfillmentDeadlineSeconds <= 0) {
    throw new Error(
      'quoteDeadlineSeconds and fulfillmentDeadlineSeconds must be positive numbers of seconds.',
    );
  }
  if (quoteDeadlineSeconds >= fulfillmentDeadlineSeconds) {
    const fulfillmentSource =
      params.fulfillmentDeadlineSeconds === undefined ? ', the default' : '';
    throw new Error(
      `quoteDeadlineSeconds (${quoteDeadlineSeconds}) must be strictly less than ` +
        `fulfillmentDeadlineSeconds (${fulfillmentDeadlineSeconds}${fulfillmentSource}). The ` +
        `gateway rejects a quote_deadline that is not before fulfillment_deadline. When you ` +
        `raise quoteDeadlineSeconds, raise fulfillmentDeadlineSeconds by the same amount.`,
    );
  }
  return { quoteDeadlineSeconds, fulfillmentDeadlineSeconds };
}

/**
 * Stamp both deadlines as ISO timestamps from a single `now`. Bidding closes at quote_deadline,
 * so builders take `now` after their own network reads: time spent fetching must not come out of
 * the window settlers have to quote.
 */
function stampDeadlines(
  windows: DeadlineWindows,
  now: number,
): { quote_deadline: string; fulfillment_deadline: string } {
  return {
    quote_deadline: new Date(now + windows.quoteDeadlineSeconds * 1000).toISOString(),
    fulfillment_deadline: new Date(now + windows.fulfillmentDeadlineSeconds * 1000).toISOString(),
  };
}

/**
 * Internal parameters for {@link assemblePaymentRequest} — everything needed to
 * assemble a signable `PaymentRequest` once the chain defaults are already in
 * hand. Not exported: callers go through {@link PaymentGatewayClient.preparePaymentRequest},
 * which resolves the defaults (fetching only what the caller didn't supply) and
 * then assembles.
 */
interface AssemblePaymentRequestParams {
  /** The payer's source-chain account (the depositor). */
  depositor: string;
  /** Exact amount the beneficiary receives, atomic units of the destination token. */
  fulfillmentAmount: string;
  /** CAIP-19 source asset identifier (`<caip2>/<type>:<address>`). */
  sourceAsset: string;
  /** The beneficiary's destination-chain account. */
  destinationAccount: string;
  /** CAIP-19 destination asset identifier. */
  destinationAsset: string;
  /** The source spend cap (`max_source_amount`), atomic units of the source token. */
  maxSourceAmount: string;
  /** The request id (also bound into the deposit authorization). */
  requestId: string;
  /** Absolute `quote_deadline` (ISO 8601). Ordering vs. `fulfillmentDeadline` is the caller's responsibility. */
  quoteDeadline: string;
  /** Absolute `fulfillment_deadline` (ISO 8601). */
  fulfillmentDeadline: string;
  /** Source-chain defaults (escrow, quote selector, verifier, plus Tron/Solana extras). */
  sourceDefaults: ChainDefaults;
  /** Destination-chain fulfillment-proxy contract. */
  fulfillmentProxy: string;
  /**
   * Explicit deposit-nonce override. When omitted, `preparePaymentRequest` derives the nonce
   * deterministically from `requestId` + depositor on every chain — the Permit2 nonce on
   * EVM/Tron, the escrow program's replay-window nonce on Solana — so a rebuild reproduces the
   * same nonce (retry-safe). On EVM/Tron it is single-use forever; on Solana the program only
   * remembers it for 256-512s. Supply a value only to override.
   */
  nonce?: bigint | string;
  /**
   * EVM/Tron-only: ABSOLUTE Permit2 deadline (Unix seconds). Required by the SDK for
   * EVM/Tron; `preparePaymentRequest` derives it from the payment's fulfillment_deadline.
   * Undefined for Solana (its deadline is the on-chain replay window off `issued_at`).
   */
  deadline?: number;
  /**
   * Solana-only: the deposit's `issued_at` (Unix seconds), already resolved by the builder. It is
   * read before the deadlines are stamped, so the cluster-clock read does not shorten the quote
   * window.
   */
  solanaIssuedAt?: bigint;
  /**
   * Stellar-only: the deposit's `issued_at` (Unix seconds), the latest closed ledger's close time,
   * already resolved by the builder for the same reason as `solanaIssuedAt`.
   */
  stellarIssuedAt?: bigint;
  /**
   * Stellar-only: the `epoch` of the payer's delegate record (`get_delegate`), which the deposit
   * digest commits to. Already resolved by the builder; never defaulted.
   */
  stellarDelegateEpoch?: bigint;
  /** Optional settler allow/deny list. */
  settlerRequirements?: SettlerRequirements;
  /**
   * Who performs deposit, reserve, and fulfill. Omitted leaves the key off the request.
   * Omitted on the wire means settler. A split object keeps the three legs as separate keys.
   */
  executor?: PaymentRequest['executor'];
  /** Override the emitted `version` (defaults to the canonical {@link PAYMENT_REQUEST_VERSION}). */
  version?: string;
}

/**
 * What a failed /v1/defaults call says, as the caller should see it: the gateway's public code
 * and message, plus the request id support needs to find the internal record. Falls back to the
 * HTTP status when the body is not the typed error shape, so a proxy's HTML is never pasted in.
 *
 * Reads the body directly rather than via `getErrorResponse`, which requires both `code` and
 * `message`, so a body carrying only one of them is still reported.
 */
function defaultsErrorDetail(error: unknown): string {
  if (!isApiError(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const body = error.body as
    { message?: unknown; code?: unknown; request_id?: unknown } | null | undefined;
  const parts: string[] = [];
  if (typeof body?.code === 'string' && body.code.trim() !== '') parts.push(body.code);
  if (typeof body?.message === 'string' && body.message.trim() !== '') parts.push(body.message);
  // Support locates the error record by request id, so it is included for the caller to quote.
  const requestId =
    typeof body?.request_id === 'string' && body.request_id.trim() !== '' ? body.request_id : '';
  if (parts.length > 0) {
    return `${parts.join(': ')}${requestId === '' ? '' : ` (request_id=${requestId})`}`;
  }
  return error.statusText || `HTTP ${error.status}`;
}

/**
 * `GET /v1/defaults` answers with ONE chain when `chain_id` is supplied and a map of every
 * chain when it is not. The SDK always supplies it, so the map shape means the gateway
 * ignored the parameter — a contract violation to report, not a value to guess at.
 *
 * A hand-written predicate rather than `'chain_id' in response`: the map arm is an index
 * signature, so TypeScript cannot narrow it away with `in` (every key is "present" on it).
 */
function singleChainOf(response: GetDefaultsResponse, chainId: string): ChainDefaultsWire {
  // A base URL that points somewhere other than the gateway can answer 200 with HTML or a
  // bare `null`; report that as such rather than as the keyed-map case or a TypeError.
  if (typeof response !== 'object' || response === null) {
    throw new Error(
      `Failed to fetch defaults for chain ${chainId}: the gateway did not return a JSON object. ` +
        'Check that the configured base URL points at the payment gateway.',
    );
  }
  const single = response as ChainDefaultsWire;
  if (typeof single.chain_id !== 'string') {
    throw new Error(
      `Failed to fetch defaults for chain ${chainId}: the gateway answered with defaults for every ` +
        'chain rather than the one requested',
    );
  }
  // These addresses are signed into the deposit authorization (escrow as Permit2 spender,
  // quote selector as reserver, verifier account as releaser), so defaults for a different
  // chain would yield a valid signature over the wrong addresses. Compared case-insensitively:
  // the gateway normalises chain_id to lower case.
  if (single.chain_id.toLowerCase() !== chainId.toLowerCase()) {
    throw new Error(
      `Failed to fetch defaults for chain ${chainId}: the gateway answered with defaults for ` +
        single.chain_id,
    );
  }
  return single;
}

/**
 * Refuses a missing request id, with the builder's reason appended to the message, and an id the
 * gateway cannot read. The strict reader that computes
 * depositRequestHash v2, and that the gateway reads payment and quote requests with, takes only
 * {@link REQUEST_ID_PATTERN}, so an id outside it is refused here rather than after a build.
 */
function assertRequestId(requestId: string | undefined, why: string): asserts requestId is string {
  if (!requestId) {
    throw new Error(`payment-gateway-client: requestId is required${why}`);
  }
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error(
      `payment-gateway-client: requestId ${JSON.stringify(requestId)} does not match ${REQUEST_ID_PATTERN.source}: ` +
        "use 1 to 128 ASCII letters, digits, '.', '_' or '-'",
    );
  }
}

/**
 * Assemble a signable `PaymentRequest` from explicit inputs, with **no network
 * access**. Internal build core behind {@link PaymentGatewayClient.preparePaymentRequest}.
 *
 * The returned request carries `sender_auth.signed_messages[0]` with the deposit
 * `message` (hash) and `message_prehash` populated and an empty `signature` —
 * ready for {@link signPaymentRequest}. Chain-specific message construction is
 * handled internally; callers never touch a chain adapter.
 */
async function assemblePaymentRequest(
  params: AssemblePaymentRequestParams,
): Promise<PaymentRequest> {
  const source = parseAssetIdentifier(params.sourceAsset);
  const destination = parseAssetIdentifier(params.destinationAsset);
  const { chainId: sourceChainId, namespace } = source;
  const adapter = getChainAdapter(sourceChainId);

  // Derive the nonce from request_id + depositor so a rebuild on retry reproduces the same
  // nonce. On EVM and Tron that is a Permit2 nonce, single-use forever; on Solana the replay
  // window forgets it after a few minutes, so a rebuild signed later is a new authorization (see
  // deterministicSolanaNonce). An explicit caller nonce wins. Solana maps the identity into its
  // slot/bucket layout.
  const nonce =
    params.nonce ??
    (namespace === 'solana'
      ? deterministicSolanaNonce({ requestId: params.requestId, depositor: params.depositor })
      : namespace === 'stellar'
        ? deterministicStellarNonce({ requestId: params.requestId, depositor: params.depositor })
        : deterministicPermitNonce({ requestId: params.requestId, depositor: params.depositor }));

  // Contract-field overrides (e.g. Tron base58 → canonical hex).
  const contractOverrides = adapter.resolveContractOverrides?.(params.sourceDefaults);

  // The body is final before the deposit is built: depositRequestHash v2 is the hash of its terms,
  // so the deposit signs exactly this body and sender_auth is the only member added after.
  const body: Omit<PaymentRequest, 'sender_auth'> = {
    version: params.version ?? PAYMENT_REQUEST_VERSION,
    request_id: params.requestId,
    source: {
      asset_identifier: source.normalized,
      account: params.depositor,
    },
    destination: [
      {
        asset_identifier: destination.normalized,
        account: params.destinationAccount,
      },
    ],
    fulfillment_amount: params.fulfillmentAmount,
    max_source_amount: params.maxSourceAmount,
    quote_deadline: params.quoteDeadline,
    fulfillment_deadline: params.fulfillmentDeadline,
    escrow_contract_address: params.sourceDefaults.escrowContract,
    quote_selector: contractOverrides?.quote_selector ?? params.sourceDefaults.quoteSelector,
    fulfillment_verifier: contractOverrides?.fulfillment_verifier ?? {
      account: params.sourceDefaults.fulfillmentVerifierAccount,
      endpoint: params.sourceDefaults.fulfillmentVerifierEndpoint,
    },
    fulfillment_proxy: params.fulfillmentProxy,
    ...(params.executor !== undefined ? { executor: params.executor } : {}),
    ...(params.settlerRequirements ? { settler_requirements: params.settlerRequirements } : {}),
  };

  // Build the deposit authorization with the shared sender_auth SDK. For Solana, the builder has
  // already resolved issued_at (RPC read, wall-clock fallback, skew); it reaches the SDK through
  // its `solanaClockReader`.
  const solanaIssuedAt = params.solanaIssuedAt;
  if (namespace === 'solana' && solanaIssuedAt === undefined) {
    throw new Error('payment-gateway-client: a Solana deposit needs its issued_at resolved');
  }
  const stellarIssuedAt = params.stellarIssuedAt;
  if (namespace === 'stellar' && stellarIssuedAt === undefined) {
    throw new Error('payment-gateway-client: a Stellar deposit needs its issued_at resolved');
  }
  const stellarDelegateEpoch = params.stellarDelegateEpoch;
  if (namespace === 'stellar' && stellarDelegateEpoch === undefined) {
    throw new Error('payment-gateway-client: a Stellar deposit needs its delegate epoch resolved');
  }
  const auth = await getSenderAuthAdapter(sourceChainId).buildAuthMessage({
    // Canonicalized: the Tron adapter resolves its Permit2 address by exact chain-id key, so an
    // uppercase namespace would miss the lookup and fail inside the SDK.
    sourceAsset: source.normalized,
    depositor: params.depositor,
    // The gateway pins the signed deposit amount to max_source_amount (the cap).
    maxSourceAmount: params.maxSourceAmount,
    sourceDefaults: params.sourceDefaults,
    // The request id and the payee the deposit commits to are read from the body itself.
    paymentRequestJSON: JSON.stringify(body),
    // v2 when the gateway lists it for the chain, v1 otherwise.
    depositRequestHashVersion: depositRequestHashVersionToSign(params.sourceDefaults),
    deadline: params.deadline,
    nonce,
    ...(solanaIssuedAt !== undefined ? { solanaClockReader: async () => solanaIssuedAt } : {}),
    ...(stellarIssuedAt !== undefined ? { issuedAt: stellarIssuedAt } : {}),
    ...(stellarDelegateEpoch !== undefined ? { delegateEpoch: stellarDelegateEpoch } : {}),
  });

  return {
    ...body,
    sender_auth: {
      message_scheme: auth.messageScheme as SenderAuthMessageScheme,
      signed_messages: [
        {
          message: auth.messageHash,
          message_prehash: auth.messagePrehash,
          signature: '',
        },
      ],
    },
  };
}

// The caller's request interceptors, then one that adds the session's headers for the
// final method and URL. It runs after the generated transport has set its headers, so it
// overrides a TOKEN-made Authorization, and before the timeout interceptor, which
// withRequestTimeout appends last.
function withSessionHeaders(
  config: Partial<OpenAPIConfig>,
  session: SessionAuthorizer,
): Partial<OpenAPIConfig> {
  const request = new Interceptors<AxiosRequestConfig>();
  for (const fn of config.interceptors?.request?._fns ?? []) request.use(fn);
  request.use(async (requestConfig) => {
    const method = String(requestConfig.method ?? 'GET').toUpperCase();
    const headers = await session.authorize(method, String(requestConfig.url ?? ''));
    if (Object.keys(headers).length > 0) {
      requestConfig.headers = {
        ...(requestConfig.headers as Record<string, string> | undefined),
        ...headers,
      } as never;
    }
    return requestConfig;
  });
  return {
    ...config,
    interceptors: { request, response: config.interceptors?.response ?? new Interceptors() },
  };
}

/** Parameters of {@link PaymentGatewayClient.prepareDirectDepositRequest}. */
export interface PrepareDirectDepositParams {
  /** The payer's source-chain root account: the account that calls directDeposit and owns the deposit. */
  depositor: string;
  /** Exact amount the beneficiary receives, atomic units of the destination token. */
  fulfillmentAmount: string;
  /** CAIP-19 source asset: an ERC-20 on an EVM chain. */
  sourceAsset: string;
  destinationAccount: string;
  destinationAsset: string;
  /** The amount the payer deposits, atomic units of the source token: the inclusive maximum it pays. */
  maxSourceAmount: string;
  /**
   * Caller-owned request id. When the deposit commits version 1, whether passed or published by
   * the gateway, it must be a UUIDv4 from `randomUUID()`, and any other id is refused: the deposit
   * commits only its hash. Use `randomUUID()` for every direct deposit, so a gateway changing
   * version never changes what you send. Generate it once, persist it with `depositNonce` before
   * funding, and reuse both for this deposit.
   */
  requestId: string;
  /** The nonce the payer passes to directDeposit, decimal uint256. Each nonce funds one deposit per account. */
  depositNonce: bigint | string;
  /**
   * The depositRequestHash version the deposit witness commits. Leave it unset: the deposit is then
   * built at the version the gateway publishes for the source chain in `GET /v1/defaults`
   * (`ChainDefaults.directDepositRequestHashVersion`), so a deposit you prepare after the gateway
   * moves to version 2 commits version 2. Each refusal below is a `DirectDepositError`, thrown
   * before anything is returned:
   *
   * - a version other than 1 or 2 (reason `version`), before any network call;
   * - a version that differs from the published one (reason `gateway_version`), because that
   *   deposit would name no payment;
   * - no version, from a gateway that publishes none (reason `version_unpublished`): a gateway that
   *   predates the published version needs the one its operator gives you, and the method does not
   *   guess;
   * - a published version this build does not know (reason `version_unknown`), whatever you pass:
   *   upgrade the client.
   *
   * Version 1 is deprecated for direct deposits; see `PreparedDirectDeposit.deprecation`.
   */
  depositRequestHashVersion?: 1 | 2;
  /** Who performs the payout leg. `'originator'` needs a destination token with EIP-3009. */
  fulfill: DirectDepositFulfill;
  /**
   * How long the auction stays open (seconds from now). Prepare once, with a window comfortably
   * longer than the deposit takes to become final, fund it, and once it is final submit the same
   * request when a short quote window remains, for example 45 seconds.
   */
  quoteDeadlineSeconds: number;
  /** Seconds from now by which the payout must be mined; must exceed `quoteDeadlineSeconds`. */
  fulfillmentDeadlineSeconds: number;
  /** Optional settler allow/deny lists: each present list holds 1 to 100 distinct settler DIDs. */
  settlerRequirements?: SettlerRequirements;
  /** Clock source for the deadlines. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Pre-resolved corridor addresses; supply both sides to build offline. The source side's
   * `directDepositRequestHashVersion`, when present, is the published version an unset
   * `depositRequestHashVersion` follows, checked as a fetched one is. Read the source chain's
   * defaults fresh for each direct deposit: defaults kept from before the gateway changed version
   * still build at the old one, which the method cannot tell, and that deposit names no payment.
   */
  resolvedDefaults?: {
    source?: ChainDefaults;
    destination?: Pick<ChainDefaults, 'fulfillmentProxy'>;
  };
}

/** What {@link PaymentGatewayClient.prepareDirectDepositRequest} returns. */
export interface PreparedDirectDeposit {
  /** The request to submit once the deposit is funded. */
  request: DirectDepositPaymentRequest;
  /**
   * The deposit the request names: fund it by calling the escrow's directDeposit with
   * `deposit.input`, from `depositor`. `deposit.depositId` is the payment id.
   */
  deposit: DirectDeposit;
  /**
   * The depositRequestHash version the deposit commits, passed or published. Persist it with
   * `requestId` and `depositNonce`: `deriveDirectDeposit` takes it to give the deposit back from
   * the stored request.
   */
  depositRequestHashVersion: 1 | 2;
  /**
   * Present on every deposit at version 1, which is deprecated for direct deposits; `message` says
   * what to do. When you passed version 1 yourself, the client also reports it as a
   * `DeprecationWarning` with the same `code`, once per process. Following a gateway that
   * publishes version 1 there is nothing for you to change, so nothing is reported: the deposits
   * move to version 2 when the gateway does.
   */
  deprecation?: DirectDepositDeprecation;
}

/**
 * Extended PaymentGatewayClient with convenience methods
 */
export class PaymentGatewayClient extends GeneratedPaymentGatewayClient {
  /**
   * The payments calls. `submitPayment` also sends this SDK's `X-Atum-Producer` and
   * `X-Atum-Deposit-Request-Hash-V2` unless the call names an `xAtumProducer`; they are used for
   * compatibility diagnostics only and never change how the payment is processed.
   */
  declare readonly payments: ShadowingPaymentsService;

  constructor(config?: PaymentGatewayClientConfig, HttpRequest?: HttpRequestConstructor) {
    // One base URL for every call, including /v1/defaults, so a payment cannot be prepared
    // against one host and submitted to another.
    //
    // Precedence: an explicit { BASE }, then the GATEWAY_URL environment variable, then the
    // built-in production-testnet default. A blank GATEWAY_URL counts as unset (hence `||`).
    // An explicit { BASE } is used verbatim, including an empty string for a same-origin proxy.
    const envBase = (typeof process !== 'undefined' ? process.env.GATEWAY_URL : undefined)?.trim();
    const base = config?.BASE ?? (envBase || defaultGateway);

    const timeouts: RequestTimeouts = {
      timeoutMs: config?.timeoutMs,
      syncWaitTimeoutMs: config?.syncWaitTimeoutMs,
    };

    const { session, ...requestConfig } = config ?? {};
    const withSession = session ? withSessionHeaders(requestConfig, session) : requestConfig;

    super(
      { ...requestConfig, BASE: base, ...withRequestTimeout(withSession, timeouts) },
      HttpRequest ?? timeoutHttpRequest(timeouts),
    );
    this.payments = new ShadowingPaymentsService(this.request);
  }

  /**
   * Fetches chain defaults from the payment gateway (`GET /v1/defaults`), using the same
   * base URL and timeout policy as the payment calls.
   *
   * @param chainId The CAIP-2 chain identifier (e.g., "eip155:42161")
   * @returns The chain defaults including escrow, quote selector, and fulfillment verifier
   * @throws If the chain id is empty, the request fails, or the response is missing a
   *   required field or describes a different chain.
   */
  async fetchChainDefaults(chainId: string): Promise<ChainDefaults> {
    // An empty chain id reaches the gateway as `?chain_id=`, which the contract defines as
    // "every chain" - so the caller would get the keyed map back and be told the gateway
    // ignored the parameter. Name the actual mistake instead.
    if (chainId.trim() === '') {
      throw new Error(
        'payment-gateway-client: fetchChainDefaults requires a CAIP-2 chain id, for example "eip155:8453"',
      );
    }
    // /v1/defaults is answered promptly and never held open, so the transport's ordinary
    // budget applies (it is not one of the sync-hold paths).
    let response: GetDefaultsResponse;
    try {
      response = await this.chainDefaults.getDefaults({ chainId });
    } catch (error) {
      // A timeout carries no gateway verdict and already names the host and budget, so it
      // propagates as-is; wrapping it would hide the type callers branch on.
      if (isGatewayTimeoutError(error)) throw error;
      // Otherwise report the gateway's own code and message. `cause` keeps the original, so a
      // caller can run `getErrorResponse(err.cause)` to decide whether to retry.
      throw new Error(
        `Failed to fetch defaults for chain ${chainId}: ${defaultsErrorDetail(error)}`,
        {
          cause: error,
        },
      );
    }

    const data = singleChainOf(response, chainId);
    if (!data.escrow_contract) {
      throw new Error('defaults missing escrow_contract');
    }
    if (!data.fulfillment_proxy) {
      throw new Error('defaults missing fulfillment_proxy');
    }
    if (!data.quote_selector) {
      throw new Error('defaults missing quote_selector');
    }
    if (!data.fulfillment_verifier) {
      throw new Error('defaults missing fulfillment_verifier');
    }
    if (!data.fulfillment_verifier.account) {
      throw new Error('defaults missing fulfillment_verifier.account');
    }
    if (!data.fulfillment_verifier.endpoint) {
      throw new Error('defaults missing fulfillment_verifier.endpoint');
    }
    // permit2_contract is published only for a chain whose escrow uses a non-canonical Permit2;
    // when absent, the signing adapters use the canonical address. A present-but-blank value
    // is refused rather than signed into the EIP-712 domain.
    if (typeof data.permit2_contract === 'string' && data.permit2_contract.trim() === '') {
      throw new Error('defaults returned an empty permit2_contract');
    }

    return {
      escrowContract: data.escrow_contract,
      quoteSelector: data.quote_selector,
      fulfillmentVerifierAccount: data.fulfillment_verifier.account,
      fulfillmentVerifierEndpoint: data.fulfillment_verifier.endpoint,
      fulfillmentProxy: data.fulfillment_proxy,
      // `?? undefined` normalises a JSON null to match the declared `string | undefined`.
      permit2Contract: data.permit2_contract ?? undefined,
      // Solana escrow domain separation; present only for Solana source chains.
      svmSignatureClusterId: data.svm_signature_cluster_id ?? undefined,
      svmSignatureDomainVersion: data.svm_signature_domain_version ?? undefined,
      // The depositRequestHash version to sign; absent is 1.
      depositRequestHashVersion: data.deposit_request_hash_version ?? undefined,
      // The versions a deposit may be signed with; absent from a gateway that predates it.
      depositRequestHashVersions: data.deposit_request_hash_versions ?? undefined,
      // The version a direct deposit's id is derived at: EVM chains only, and absent from a
      // gateway that predates it. Carried as published, a version this build does not know
      // included, so that prepareDirectDepositRequest refuses it rather than build at another.
      directDepositRequestHashVersion: data.direct_deposit_request_hash_version ?? undefined,
    };
  }

  /**
   * Prepares a payment request with defaults, ready for signing.
   *
   * By default this resolves the corridor addresses from the gateway `/v1/defaults`
   * endpoint. It reaches the gateway only for what the caller has NOT already
   * supplied via `resolvedDefaults`: supply `resolvedDefaults.source` to skip the
   * source-chain fetch and `resolvedDefaults.destination` to skip the destination
   * fetch. Supplying both builds the request **entirely offline** (no network) —
   * how a caller that already holds the corridor addresses (e.g. from a signed
   * challenge) constructs and signs a request without gateway access. Such a
   * caller typically also injects `now` so the deadlines are deterministic.
   *
   * @example Minimal — fetch corridor addresses from the gateway, then sign
   * ```ts
   * const client = new PaymentGatewayClient({ BASE: "https://gateway.example.com" });
   *
   * const request = await client.preparePaymentRequest({
   *   depositor: "0xPayerAddress",
   *   sourceAsset: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",       // USDC on Base
   *   destinationAccount: "0xMerchantAddress",
   *   destinationAsset: "eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC on Arbitrum
   *   fulfillmentAmount: "10000000", // 10 USDC (6 decimals)
   *   maxSourceAmount: "10010000",   // at most 10.01 USDC from the payer (source units)
   *   requestId: "order-4711",
   * });
   * // Deadlines and the nonce are defaulted; the spend cap never is.
   *
   * const signer = createSenderSigner("eip155:8453", { provider: "raw", privateKey });
   * await signPaymentRequest(request, signer); // fills sender_auth, ready to submit
   * ```
   *
   * @param params Payment parameters
   * @returns A complete PaymentRequest object without the signature
   */
  async preparePaymentRequest(params: {
    // What's being paid
    depositor: string;
    fulfillmentAmount: string;
    sourceAsset: string;
    destinationAccount: string;
    destinationAsset: string;
    /**
     * REQUIRED spend cap in the source token's smallest units: signed into the Permit2 as the most
     * the escrow may take. Never derived here, because that needs both tokens' decimals and a
     * price. Build it from a settler quote with `capFromQuote`, or state it explicitly.
     */
    maxSourceAmount: string;

    // IDs / bookkeeping
    /**
     * REQUIRED idempotency key. It seeds the deterministic deposit nonce, so a retry that
     * reuses the same `requestId` reproduces the same nonce, and the gateway dedups on it. On
     * EVM/Tron that nonce is single-use forever, so a duplicate deposit reverts; on Solana the
     * program only remembers it for 256-512s, so after that the gateway's dedup is the
     * protection (see `nonce` below). The caller owns it and must reuse it on retry — there is
     * no auto-generated fallback (a random one would silently break idempotency).
     */
    requestId: string;
    settlerRequirements?: SettlerRequirements;

    // Timing (relative "seconds from now")
    /** How long the auction stays open (seconds from now). */
    quoteDeadlineSeconds?: number;
    /**
     * Seconds from now by which the payout must be mined on the destination chain. Defaults to
     * {@link DEFAULT_FULFILLMENT_DEADLINE_SECONDS}; pass more for large payments.
     */
    fulfillmentDeadlineSeconds?: number;
    /** EVM/Tron-only: the Permit2 signature's own on-chain expiry (seconds from now). */
    deadlineSeconds?: number;
    /** Clock source used to stamp the deadlines. Defaults to `Date.now`; inject for offline/deterministic builds. */
    now?: () => number;

    // Chain-specific
    /**
     * Explicit deposit-nonce override. Omit in normal use: the nonce is then derived from
     * `requestId` + depositor, so rebuilding the same payment reproduces it.
     *   - EVM/Tron: the Permit2 nonce is a permanent on-chain bitmap, so only one deposit can
     *     settle across any number of rebuilds.
     *   - Solana: the replay nonce is only remembered for 256-512s after `issued_at` (the
     *     authorization itself is valid for 128s), and `issued_at` is re-read on each build.
     *     The gateway also deduplicates on `request_id`; pin `issued_at` via `solanaClockReader`
     *     to keep a rebuild in the same window.
     */
    nonce?: bigint | string;
    /** Solana-only: override the RPC used to read the cluster clock for issued_at. */
    solanaRpcUrl?: string;
    /** Solana-only: injectable clock reader for `issued_at` (offline / test seam). */
    solanaClockReader?: SolanaClusterUnixTimeReader;
    /** Stellar-only: override the Soroban RPC used to read the latest ledger's close time for issued_at. */
    stellarRpcUrl?: string;
    /** Stellar-only: injectable ledger close-time reader for `issued_at` (offline / test seam). */
    stellarClockReader?: StellarLedgerCloseTimeReader;
    /**
     * Stellar-only, the epoch of the payer's delegate record for (depositor, token): the escrow's
     * `get_delegate(...).epoch`, or what `create_delegate` returned. The deposit digest commits to it,
     * so a deposit signed under one record is void under a later one. Omitted, the builder reads it
     * from the escrow through the Soroban RPC (`stellarRpcUrl`) and fails if the payer has no
     * delegate registered; it is never defaulted to 1.
     */
    stellarDelegateEpoch?: bigint | number | string;
    /**
     * Stellar-only: injectable delegate-epoch reader (offline / test seam). It returns the epoch
     * alone, so the checks on the record's expiration, capacity and signer cannot run; use
     * `stellarDelegateRecordReader` to keep them.
     */
    stellarDelegateEpochReader?: StellarDelegateEpochReader;
    /** Stellar-only: injectable delegate-record reader (offline / test seam). */
    stellarDelegateRecordReader?: StellarDelegateRecordReader;
    /**
     * Stellar-only, the `G...` strkey of the key that will sign the deposit. When the delegate record
     * is read from the escrow (no `stellarDelegateEpoch`), it must be the record's registered signer,
     * or the build fails: the escrow verifies the signature against that signer, so a payer signing
     * with another key would revert at `deposit`. Omitted, the signer is not compared.
     */
    stellarSigningKey?: string;
    /**
     * Who performs deposit, reserve, and fulfill. Omitted leaves the key off. Omitted on the
     * wire means settler. Send-payment does not set this.
     */
    executor?: PaymentRequest['executor'];

    /**
     * Pre-resolved corridor addresses. Omit to fetch them from the gateway
     * `/v1/defaults`; supply to build offline. Each side is resolved independently —
     * a field left out is still fetched. The destination contributes only its
     * `fulfillmentProxy` (its escrow/roles are source-side concepts, unused here).
     */
    resolvedDefaults?: {
      source?: ChainDefaults;
      destination?: Pick<ChainDefaults, 'fulfillmentProxy'>;
    };
  }): Promise<PaymentRequest> {
    // An originator-executed deposit is funded by the payer and carries no sender_auth; this
    // builder would sign a Permit2 deposit for it that the gateway then refuses.
    const executor = params.executor;
    if (
      executor === 'originator' ||
      (typeof executor === 'object' && executor.deposit === 'originator')
    ) {
      throw new Error(
        'payment-gateway-client: preparePaymentRequest builds a Permit2-funded request; for an ' +
          'originator-executed deposit use prepareDirectDepositRequest',
      );
    }
    assertPayableAccount(params.destinationAsset, params.destinationAccount);
    // Validated before any network call; stamped only after the network reads below.
    const windows = resolveDeadlineWindows(params, DEFAULT_PAYMENT_QUOTE_DEADLINE_SECONDS);

    // Checked before any network call: a missing or malformed cap must never reach a signature.
    const maxSourceAmount = resolveMaxSourceAmount(params.maxSourceAmount, 'required', {
      sourceAsset: params.sourceAsset,
      destinationAsset: params.destinationAsset,
    });

    // Validated before the defaults fetch, so a malformed identifier is named here rather than
    // surfacing as a chain the gateway does not know.
    const sourceChainId = assetChainId(params.sourceAsset);
    const destChainId = assetChainId(params.destinationAsset);

    // Required at runtime as well as in the type: it is the idempotency key (see `requestId`).
    assertRequestId(
      params.requestId,
      ' — it is the idempotency key that seeds the ' +
        'deterministic deposit nonce; supply a stable id per logical payment and reuse it on retry',
    );
    const requestId = params.requestId;

    // Resolve chain defaults, fetching ONLY what the caller didn't already supply
    // (a supplied value resolves immediately; the two fetches still run in parallel).
    // Supplying both sides skips the gateway entirely — a fully offline build. A Solana
    // deposit's issued_at is read alongside them.
    const sourceNamespace = sourceChainId.split(':')[0];
    const [sourceDefaults, fulfillmentProxy, solanaIssuedAt, stellarIssuedAt] = await Promise.all([
      params.resolvedDefaults?.source ?? this.fetchChainDefaults(sourceChainId),
      params.resolvedDefaults?.destination?.fulfillmentProxy ??
        this.fetchChainDefaults(destChainId).then((d) => d.fulfillmentProxy),
      sourceNamespace === 'solana'
        ? resolveSolanaIssuedAt({
            sourceChainId,
            rpcUrlOverride: params.solanaRpcUrl,
            reader: params.solanaClockReader,
          })
        : undefined,
      sourceNamespace === 'stellar'
        ? resolveStellarIssuedAt({
            sourceChainId,
            rpcUrlOverride: params.stellarRpcUrl,
            reader: params.stellarClockReader,
          })
        : undefined,
    ]);

    // The delegate record is on-chain state keyed by the escrow and token, so it can be read only
    // once the defaults are known. A caller-supplied epoch skips the read, and with it the checks on
    // the record below: only a record that was read can be checked.
    const stellarDelegate =
      sourceNamespace === 'stellar'
        ? await resolveStellarDelegate({
            sourceChainId,
            escrow: sourceDefaults.escrowContract,
            depositor: params.depositor,
            token: parseAssetIdentifier(params.sourceAsset).tokenAddress,
            epoch: params.stellarDelegateEpoch,
            rpcUrlOverride: params.stellarRpcUrl,
            reader: params.stellarDelegateEpochReader,
            recordReader: params.stellarDelegateRecordReader,
          })
        : undefined;
    const stellarDelegateEpoch = stellarDelegate?.epoch;
    // Refused here, before the payer signs: otherwise the request passes the gateway and the auction
    // and reverts only at `deposit`.
    if (stellarDelegate?.record !== undefined && stellarIssuedAt !== undefined) {
      assertStellarDelegateUsable(stellarDelegate.record, {
        depositor: params.depositor,
        issuedAt: stellarIssuedAt,
        ...(params.stellarSigningKey !== undefined ? { signerKey: params.stellarSigningKey } : {}),
      });
    }

    // Bidding closes at quote_deadline, so the clock is read only now that the network reads are
    // done; their latency must not come out of the window settlers have to quote. One read
    // serves the deadline stamps and the permit deadline below, so a permit derived from
    // fulfillment_deadline always outlives it.
    const now = (params.now ?? Date.now)();
    const { quote_deadline, fulfillment_deadline } = stampDeadlines(windows, now);

    // The EVM/Tron permit deadline is absolute (Unix seconds) and defaults to
    // fulfillment_deadline + 1s, so the permit outlives settlement. A relative `deadlineSeconds`
    // is converted against the same clock. Solana derives its deadline from the ~128s replay
    // window instead.
    let permitDeadline: number | undefined;
    if (sourceNamespace !== 'solana') {
      const fulfillmentMs = Date.parse(fulfillment_deadline);
      if (params.deadlineSeconds !== undefined) {
        // The permit must stay valid until settlement, or the on-chain deposit pull reverts.
        // Compared in milliseconds, as the gateway does; equal is allowed. Seconds are rounded
        // up so a sub-second `now` does not put the permit just below fulfillment_deadline.
        permitDeadline = Math.ceil(now / 1000) + Math.ceil(params.deadlineSeconds);
        if (permitDeadline * 1000 < fulfillmentMs) {
          throw new Error(
            `payment-gateway-client: deadlineSeconds (${params.deadlineSeconds}) expires the deposit permit before ` +
              `settlement (fulfillmentDeadlineSeconds). The permit must stay valid until settlement — pass a deadlineSeconds ` +
              `at least as long as fulfillmentDeadlineSeconds, or omit it to derive it from fulfillment_deadline automatically.`,
          );
        }
      } else {
        // Default: one second past the settlement horizon, so the permit always outlives it.
        permitDeadline = Math.floor(fulfillmentMs / 1000) + 1;
      }
    }

    return assemblePaymentRequest({
      depositor: params.depositor,
      fulfillmentAmount: params.fulfillmentAmount,
      sourceAsset: params.sourceAsset,
      destinationAccount: params.destinationAccount,
      destinationAsset: params.destinationAsset,
      maxSourceAmount,
      requestId,
      quoteDeadline: quote_deadline,
      fulfillmentDeadline: fulfillment_deadline,
      sourceDefaults,
      fulfillmentProxy,
      nonce: params.nonce,
      deadline: permitDeadline,
      solanaIssuedAt,
      stellarIssuedAt,
      stellarDelegateEpoch,
      settlerRequirements: params.settlerRequirements,
      executor: params.executor,
    });
  }

  /**
   * Prepares an originator-executed (direct) deposit request: the payer funds the escrow itself
   * with approve + directDeposit, so the request carries no `sender_auth`. Nothing is signed and
   * no funding transaction is built; the caller's wallet owns funding.
   *
   * Corridor addresses resolve as in {@link preparePaymentRequest}: fetched from `/v1/defaults`
   * unless supplied via `resolvedDefaults`; supplying both sides builds offline.
   *
   * Leave `depositRequestHashVersion` unset and the deposit commits the version the gateway
   * publishes for the source chain, so a deposit prepared after the gateway changes version commits
   * the new one. A version that differs from the published one, no version from a gateway that
   * publishes none, and a published version this build does not know are each refused with a
   * `DirectDepositError` before anything is returned. A deposit funded before the gateway changes
   * version but submitted after names no payment, and comes back only through `refundUnreserved`,
   * so keep the time between preparing and submitting as short as finality allows.
   *
   * Version 1 is deprecated for direct deposits: every deposit at version 1 carries `deprecation`.
   * Passing version 1 yourself also reports it as a `DeprecationWarning`, once per process. Under
   * `--throw-deprecation` (`process.throwDeprecation`) the method instead rejects with that
   * warning, an `Error` named `DeprecationWarning` with the code `ATUM_DIRECT_DEPOSIT_V1`, every
   * time and before returning a deposit, so you can catch it.
   *
   * When the deposit commits version 1, `requestId` must be a UUIDv4 from `randomUUID()`; any
   * other id is refused. Persist it with `depositNonce` and the returned
   * `depositRequestHashVersion` before funding, and reuse them for this deposit.
   *
   * Persist the request you submit as JSON. On a retry, submit those same stored bytes with
   * `payments.submitPayment` rather than preparing a new request. See "Funding the deposit
   * yourself" in the README for when to prepare relative to funding and finality.
   */
  async prepareDirectDepositRequest(
    params: PrepareDirectDepositParams,
  ): Promise<PreparedDirectDeposit> {
    assertDirectDepositHashVersion(params.depositRequestHashVersion);
    assertPayableAccount(params.destinationAsset, params.destinationAccount);
    assertRequestId(
      params.requestId,
      ' for a direct deposit: it is committed in the ' +
        'deposit, so persist it with depositNonce before funding and reuse both on retry',
    );
    // A version passed explicitly is checked against the id before any network call; an unset one
    // is known only once the defaults are read, and is checked then.
    if (params.depositRequestHashVersion !== undefined) {
      assertDirectDepositRequestId(params.depositRequestHashVersion, params.requestId);
    }
    const sourceEvmChainId = directDepositSourceChainId(params.sourceAsset);
    assertEvmAccount('depositor', assetChainId(params.sourceAsset), params.depositor);
    const depositNonce = directDepositNonce(params.depositNonce);
    assertDirectDepositWindows(params);
    assertDirectDepositFulfillmentAmount(params.fulfillmentAmount);
    const maxSourceAmount = directDepositAmount(params.maxSourceAmount, params);
    assertSettlerRequirements(params.settlerRequirements);
    const windows = resolveDeadlineWindows(params, params.quoteDeadlineSeconds);
    const sourceChainId = assetChainId(params.sourceAsset);
    const destChainId = assetChainId(params.destinationAsset);
    const [sourceDefaults, fulfillmentProxy] = await Promise.all([
      params.resolvedDefaults?.source ?? this.fetchChainDefaults(sourceChainId),
      params.resolvedDefaults?.destination?.fulfillmentProxy ??
        this.fetchChainDefaults(destChainId).then((d) => d.fulfillmentProxy),
    ]);
    assertEvmAccount('the escrow', sourceChainId, sourceDefaults.escrowContract, {
      allowZero: true,
    });
    assertEvmAccount('the quote selector', sourceChainId, sourceDefaults.quoteSelector, {
      allowZero: true,
    });
    assertEvmAccount(
      'the verifier account',
      sourceChainId,
      sourceDefaults.fulfillmentVerifierAccount,
      {
        allowZero: true,
      },
    );
    assertVerifierEndpoint(sourceDefaults.fulfillmentVerifierEndpoint);
    const now = (params.now ?? Date.now)();
    const { quote_deadline, fulfillment_deadline } = stampDeadlines(windows, now);
    assertOrderedDeadlines({ quote_deadline, fulfillment_deadline });
    const request = buildDirectDepositRequest({
      version: PAYMENT_REQUEST_VERSION,
      depositor: params.depositor,
      fulfillmentAmount: params.fulfillmentAmount,
      sourceAsset: params.sourceAsset,
      destinationAccount: params.destinationAccount,
      destinationAsset: params.destinationAsset,
      maxSourceAmount,
      requestId: params.requestId,
      depositNonce,
      fulfill: params.fulfill,
      quoteDeadline: quote_deadline,
      fulfillmentDeadline: fulfillment_deadline,
      sourceDefaults,
      fulfillmentProxy,
      settlerRequirements: params.settlerRequirements,
    });
    const requestJson = JSON.stringify(request);
    validatePaymentRequestJSON(requestJson);
    // Resolved once the request and the defaults it carries have passed every check, so a malformed
    // default, the quote selector above all, is reported as itself rather than as a version the
    // gateway does not publish; and before the deposit is derived, so a version the gateway would
    // not name a payment for is refused before the caller holds a deposit it could fund.
    const version = resolveDirectDepositHashVersion(
      params.depositRequestHashVersion,
      sourceDefaults.directDepositRequestHashVersion,
      sourceChainId,
    );
    assertDirectDepositRequestId(version, params.requestId);
    const deposit = deriveDirectDeposit(
      requestJson,
      sourceEvmChainId,
      sourceDefaults.escrowContract,
      version,
    );
    if (version === 2) return { request, deposit, depositRequestHashVersion: version };
    const passed = params.depositRequestHashVersion === 1;
    const deprecation = directDepositV1Deprecation(passed, sourceChainId);
    // Reported only to a caller that named version 1: one following the gateway moves to version 2
    // with it, so there is nothing for it to act on. Under --throw-deprecation this throws, before
    // the deposit is returned.
    if (passed) reportDirectDepositDeprecation(deprecation);
    return { request, deposit, depositRequestHashVersion: version, deprecation };
  }

  /**
   * Prepares a quote-request body (`CreateQuoteRequest`), ready to POST to
   * `/v1/payments/quote-requests`. It carries the same corridor and contract fields as
   * `preparePaymentRequest` but no `sender_auth`: quoting needs no signature or private key,
   * and the spend authorization is supplied at award time.
   *
   * Both deadlines are populated because the gateway requires them and injects no defaults.
   * `quote_deadline` (default `DEFAULT_QUOTE_DEADLINE_SECONDS`) must be strictly earlier than
   * `fulfillment_deadline` (default `DEFAULT_FULFILLMENT_DEADLINE_SECONDS`) and strictly in the
   * gateway's future, so a caller whose clock lags the gateway should pass a larger
   * `quoteDeadlineSeconds`.
   *
   * @param params Quote-request parameters
   * @returns A complete `CreateQuoteRequest` body (no signature step needed)
   */
  async prepareQuoteRequest(params: {
    depositor: string;
    fulfillmentAmount: string;
    sourceAsset: string;
    destinationAccount: string;
    destinationAsset: string;
    /**
     * Spend cap in the source token's smallest units; settlers' quotes above it are filtered.
     * Omit it to request quotes with no cap: nothing is sent, and the SDK never derives one.
     * A supplied value must be a positive base-10 integer. To cap a later payment from a quote,
     * see `capFromQuote`.
     */
    maxSourceAmount?: string;
    /**
     * The request id. Reuse the SAME value to retry: the gateway returns the original batch
     * (same `quote_request_id`) instead of opening a second one, and answers `409`
     * IDEMPOTENCY_TERMS_MISMATCH if you reuse it for a different corridor.
     */
    requestId: string;
    settlerRequirements?: SettlerRequirements;
    quoteDeadlineSeconds?: number;
    /**
     * Seconds from now by which the payout must be mined on the destination chain. Defaults to
     * {@link DEFAULT_FULFILLMENT_DEADLINE_SECONDS}; pass more for large payments.
     */
    fulfillmentDeadlineSeconds?: number;
    /**
     * The account that picks the quote at award and signs its `reserve_auth`. Defaults to
     * `depositor`. A payment service provider paying for a customer names its own address here,
     * so the customer signs only the deposit. It cannot be the gateway's own selector from
     * `/v1/defaults`.
     */
    quoteSelector?: string;
  }): Promise<CreateQuoteRequest> {
    assertPayableAccount(params.destinationAsset, params.destinationAccount);
    // Required at runtime as well as in the type: it is the idempotency key, and a generated one
    // would make a rebuilt retry open a second batch.
    assertRequestId(
      params.requestId,
      ' — it is the idempotency key the gateway ' +
        'dedups on; supply a stable id per logical quote-request and reuse it on retry',
    );
    // A quote authorizes nothing, and the gateway reads an absent cap as "no cap", so an omitted
    // cap is left off rather than derived.
    const maxSourceAmount = resolveMaxSourceAmount(params.maxSourceAmount, 'optional');

    const windows = resolveDeadlineWindows(params, DEFAULT_QUOTE_DEADLINE_SECONDS);

    const source = parseAssetIdentifier(params.sourceAsset);
    const destination = parseAssetIdentifier(params.destinationAsset);
    const sourceChainId = source.chainId;
    const destChainId = destination.chainId;
    if (params.quoteSelector !== undefined) {
      validateChainAccount(sourceChainId, params.quoteSelector);
    }
    const [sourceDefaults, destDefaults] = await Promise.all([
      this.fetchChainDefaults(sourceChainId),
      this.fetchChainDefaults(destChainId),
    ]);
    // Stamped after the fetch, so its latency does not come out of the quote window.
    const { quote_deadline, fulfillment_deadline } = stampDeadlines(windows, Date.now());

    // The same override resolution as the payment path, so both carry identical
    // fulfillment_verifier values, and the selector is written in the same form.
    const adapter = getChainAdapter(sourceChainId);
    const contractOverrides = adapter.resolveContractOverrides?.(sourceDefaults);
    const gatewaySelector = contractOverrides?.quote_selector ?? sourceDefaults.quoteSelector;
    const selector = params.quoteSelector ?? params.depositor;
    const quoteSelector =
      adapter.resolveContractOverrides?.({ ...sourceDefaults, quoteSelector: selector })
        ?.quote_selector ?? selector;
    if (sameAccount(source.namespace, quoteSelector, gatewaySelector)) {
      throw new Error(
        `payment-gateway-client: quote_selector ${selector} is the gateway's own selector, which ` +
          'signs no award; name the depositor or your own account',
      );
    }

    return {
      version: PAYMENT_REQUEST_VERSION,
      request_id: params.requestId,
      source: {
        asset_identifier: source.normalized,
        account: params.depositor,
      },
      destination: [
        {
          asset_identifier: destination.normalized,
          account: params.destinationAccount,
        },
      ],
      fulfillment_amount: params.fulfillmentAmount,
      ...(maxSourceAmount !== undefined ? { max_source_amount: maxSourceAmount } : {}),
      quote_deadline,
      fulfillment_deadline,
      escrow_contract_address: sourceDefaults.escrowContract,
      quote_selector: quoteSelector,
      fulfillment_verifier: contractOverrides?.fulfillment_verifier ?? {
        account: sourceDefaults.fulfillmentVerifierAccount,
        endpoint: sourceDefaults.fulfillmentVerifierEndpoint,
      },
      fulfillment_proxy: destDefaults.fulfillmentProxy,
      ...(params.settlerRequirements ? { settler_requirements: params.settlerRequirements } : {}),
    };
  }

  /**
   * Awards a quote: signs the deposit for exactly the quote's `source_amount` and the reserve
   * naming its settler, then sends them to `POST /v1/payments/awards`.
   *
   * `quoteRequest` must be the body you sent to open the quote request, unchanged: the deposit
   * commits it, and the gateway checks the deposit against the copy it stored. Before anything is
   * signed, the quote is checked to quote that body, and its `award_deadline` to be ahead. The
   * quote's `source_amount` and `settler_address` are signed as given: check the quote with
   * `verifyFulfillmentQuote` from the `/signing` entry and compare its `signerDID` with the
   * settlers you accept. When the quote request sets `maxSourceAmount`, no quote above it is
   * signed; open quote requests with one to bound what an award can charge.
   *
   * Reuse the same `requestId` to retry an award: the gateway answers with the original payment.
   * After the `award_deadline`, retry with the quote as `getQuoteRequestStatus` lists it: a quote
   * that carries `awarded_payment_id` skips the deadline check.
   *
   * @example
   * ```ts
   * import { verifyFulfillmentQuote } from '@atumlabs/payment-gateway-client/signing';
   *
   * const quoteRequest = await client.prepareQuoteRequest({ ..., maxSourceAmount: '101000' });
   * const opened = await client.quoteRequests.createQuoteRequest({ requestBody: quoteRequest, wait: true });
   * // The cheapest quote signed by a settler you accept.
   * const trustedSettlers = new Set(['did:pkh:eip155:1:0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc']);
   * let chosen;
   * for (const quote of 'quotes' in opened ? opened.quotes : []) {
   *   const check = await verifyFulfillmentQuote(quote);
   *   if (!check.valid || !trustedSettlers.has(check.signerDID!)) continue;
   *   const amount = BigInt(quote.fulfillment_quote.source_amount as string);
   *   if (!chosen || amount < BigInt(chosen.fulfillment_quote.source_amount as string)) chosen = quote;
   * }
   * if (!chosen) throw new Error('no quote to award');
   * const { response } = await client.awardQuote({
   *   requestId: 'award-4711',
   *   quoteRequestId: opened.quote_request_id,
   *   quoteRequest,
   *   quote: chosen,
   *   depositorSigner: createSenderSigner(chainId, { privateKey }),
   * });
   * ```
   */
  async awardQuote(params: AwardQuoteParams): Promise<AwardQuoteResult> {
    assertRequestId(
      params.requestId,
      ': it is the award idempotency key and ' +
        'seeds the deposit nonce; reuse it to retry the award',
    );
    const inputs = readAwardInputs({ ...params, now: (params.now ?? Date.now)() });

    const [chainDefaults, solanaIssuedAt, stellarIssuedAt, stellarDelegate] = await Promise.all([
      params.resolvedDefaults ?? this.fetchChainDefaults(inputs.chainId),
      inputs.namespace === 'solana'
        ? resolveSolanaIssuedAt({
            sourceChainId: inputs.chainId,
            rpcUrlOverride: params.solanaRpcUrl,
            reader: params.solanaClockReader,
          })
        : undefined,
      inputs.namespace === 'stellar'
        ? resolveStellarIssuedAt({
            sourceChainId: inputs.chainId,
            rpcUrlOverride: params.stellarRpcUrl,
            reader: params.stellarClockReader,
          })
        : undefined,
      // The deposit commits to the payment's escrow and source token, so this read does not
      // depend on the gateway defaults or on the ledger clock.
      inputs.namespace === 'stellar'
        ? resolveStellarDelegate({
            sourceChainId: inputs.chainId,
            escrow: params.quoteRequest.escrow_contract_address,
            depositor: inputs.depositor,
            token: parseAssetIdentifier(inputs.sourceAsset).tokenAddress,
            epoch: params.stellarDelegateEpoch,
            rpcUrlOverride: params.stellarRpcUrl,
            reader: params.stellarDelegateEpochReader,
            recordReader: params.stellarDelegateRecordReader,
          })
        : undefined,
    ]);
    // As in preparePaymentRequest: a record the escrow would reject at `deposit` is refused before
    // the payer signs. A supplied epoch, or an epoch-only reader, reads no record to check.
    if (stellarDelegate?.record !== undefined && stellarIssuedAt !== undefined) {
      assertStellarDelegateUsable(stellarDelegate.record, {
        depositor: inputs.depositor,
        issuedAt: stellarIssuedAt,
        ...(params.stellarSigningKey !== undefined ? { signerKey: params.stellarSigningKey } : {}),
      });
      const sourceAmount = BigInt(inputs.sourceAmount);
      if (
        sourceAmount > stellarDelegate.record.maxTransferSize ||
        sourceAmount > stellarDelegate.record.remainingCapacity
      ) {
        throw new Error(
          'payment-gateway-client: the quote amount exceeds the Stellar delegate transfer or remaining capacity limit',
        );
      }
    }
    const { request, paymentId } = await signAward({
      ...params,
      inputs,
      chainDefaults,
      depositRequestHashVersion: depositRequestHashVersionToSign(chainDefaults),
      solanaIssuedAt,
      stellarIssuedAt,
      resolvedDelegateEpoch: stellarDelegate?.epoch,
      stellarDelegateSigner: stellarDelegate?.record?.delegateSigner,
    });
    const response = await this.quoteRequests.awardQuote({
      requestBody: request,
      wait: params.wait,
    });
    return { paymentId, response, request };
  }
}

/** The inputs of {@link PaymentGatewayClient.awardQuote}. */
export interface AwardQuoteParams {
  /**
   * The award's idempotency key. It shares one namespace with the `request_id` of
   * `POST /v1/payments`, so use a value not used there. It seeds the deposit nonce, so a retry
   * with the same key signs the same EVM or Tron deposit.
   */
  requestId: string;
  /** The `quote_request_id` the quote request was opened with. */
  quoteRequestId: string;
  /** The quote request body exactly as it was sent. */
  quoteRequest: CreateQuoteRequest;
  /** The chosen quote, as the quote-request endpoints list it. */
  quote: Quote | AwardedQuote;
  /** Signs `sender_auth`: the owner of the quote request's `source.account`. */
  depositorSigner: SenderSigner;
  /**
   * Signs `reserve_auth`: the quote request's `quote_selector`. Required when it names an account
   * other than `source.account`; otherwise `depositorSigner` signs the reserve.
   */
  selectorSigner?: SenderSigner;
  /** Hold the connection until the payment reaches a result, as `POST /v1/payments?wait=true`. */
  wait?: boolean;
  /** The source chain's defaults. Omit to fetch them from `/v1/defaults`. */
  resolvedDefaults?: ChainDefaults;
  /** Solana-only: override the RPC used to read the cluster clock for issued_at. */
  solanaRpcUrl?: string;
  /** Solana-only: injectable clock reader for `issued_at`. */
  solanaClockReader?: SolanaClusterUnixTimeReader;
  /** Stellar-only: override the Soroban RPC used to read the latest ledger's close time and the delegate's epoch. */
  stellarRpcUrl?: string;
  /** Stellar-only: injectable ledger close-time reader for `issued_at`. */
  stellarClockReader?: StellarLedgerCloseTimeReader;
  /**
   * Stellar-only: the `epoch` of the payer's delegate record for the quote request's escrow and
   * token (`get_delegate`, or what `createStellarDelegate` returned). Omit it to read the record from
   * the escrow through the Soroban RPC; it is never assumed.
   */
  stellarDelegateEpoch?: bigint | number | string;
  /**
   * Stellar-only: injectable delegate-epoch reader. It returns the epoch alone, so the checks on the
   * record's expiration, capacity and signer cannot run; use `stellarDelegateRecordReader` to keep
   * them.
   */
  stellarDelegateEpochReader?: StellarDelegateEpochReader;
  /** Stellar-only: injectable delegate-record reader (offline / test seam). */
  stellarDelegateRecordReader?: StellarDelegateRecordReader;
  /**
   * Stellar-only: the `G...` strkey of the key that signs the deposit (`depositorSigner`). When the
   * delegate record is read from the escrow (no `stellarDelegateEpoch`), it must be the record's
   * registered signer, or the award fails before signing: the escrow verifies the deposit signature
   * against that signer. Omitted, the signer is not compared.
   */
  stellarSigningKey?: string;
  /** Clock for the `award_deadline` check. Defaults to `Date.now`. */
  now?: () => number;
}

/** What {@link PaymentGatewayClient.awardQuote} sent and got back. */
export interface AwardQuoteResult {
  /**
   * The id of the deposit this call signed, which the escrow knows it by. It equals
   * `response.payment_id`, except on an idempotent replay of an award first signed with a
   * different signature: then track `response.payment_id`, the original award's payment.
   */
  paymentId: string;
  response: PaymentResponse;
  /** The award body sent. Re-send it unchanged to retry. */
  request: AwardRequest;
}
