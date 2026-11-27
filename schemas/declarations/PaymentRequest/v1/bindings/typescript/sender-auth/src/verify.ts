import type { PaymentRequest } from '@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript';
import type {
  SignedMessageInput,
  SourceRef,
  VerifiedSenderAuth,
  VerifyExpectations,
} from './types.js';
import { getChainAdapter } from './adapters/index.js';
import { parseSourceAsset } from './utils.js';
import type {
  CommitmentExpectation,
  CommitmentOptions,
  CommitmentResult,
  SolanaDomain,
} from './commitment-rules.js';
import { checkRequestCommitment, verifyRequestCommitment } from './commitment.js';
import { depositRequestHashV2Off, emptyResult, refuse } from './commitment-rules.js';
import { decodeUtf8 } from './json-members.js';

export interface VerifyResult {
  /** One entry per `sender_auth.signed_messages[]`, in order. */
  results: VerifiedSenderAuth[];
  /**
   * The `source.account` every signature was verified to recover to. On Stellar the signature is by
   * that account's own key as its delegate (a separate delegate throws `DelegateUnverifiedError`),
   * but consent is still established only by the on-chain delegate registration (see
   * `ParsedPermit.delegateSigner` and `delegateOnchainUnverified`), never by this field.
   */
  recoveredAccount: string;
  /**
   * The commitment check's result, once {@link verifyPaymentRequestJSON} is opted in with
   * `expected.depositRequestHashV2Mode`: the version the deposit matched and, in audit mode,
   * `strictDetail`. Absent otherwise. Mirrors the Go `VerifyResult.Commitment`.
   */
  commitment?: CommitmentResult;
}

/**
 * Expectations for {@link verifyPaymentRequest}. The scheme fields (escrow / roles / svm)
 * behave as in {@link VerifyExpectations}. The three fields below let a caller bind the
 * recovered permit against its **own agreed terms** rather than the request's self-reported
 * ones — see the security note on {@link verifyPaymentRequest}.
 */
export interface VerifyPaymentRequestExpectations extends Omit<
  VerifyExpectations,
  'maxSourceAmount'
> {
  /**
   * Authoritative source-asset address (bare token, no CAIP prefix) to bind the recovered
   * permit token against. When omitted, the token is only checked against the request's own
   * `source.asset_identifier` (self-consistency, not a check against caller terms).
   */
  sourceAsset?: string;
  /**
   * Authoritative CAIP-2 network to verify against. When omitted, it is parsed from the
   * request's `source.asset_identifier`.
   */
  network?: string;
  /**
   * Authoritative max source amount to bind the permit amount against. When omitted, the
   * request's own `max_source_amount` is used (self-consistency, not a check against caller
   * terms).
   */
  maxSourceAmount?: string;
  /**
   * How {@link verifyPaymentRequestJSON} reads depositRequestHash v2, as the `depositRequestHashV2Mode`
   * option does for `verifyRequestCommitment`. Absent, it is exactly as before v2. It does not read
   * `retire`, which it refuses as `verifier_misconfigured`: judge a deposit in `retire` mode with
   * `verifyRequestCommitment`. {@link verifyPaymentRequest} accepts only v1 and refuses any mode as
   * `verifier_misconfigured`.
   */
  depositRequestHashV2Mode?: Exclude<CommitmentOptions['depositRequestHashV2Mode'], 'retire'>;
}

/**
 * `verifyPaymentRequest` over the request exactly as received. It refuses member names ambiguous in
 * what it reads, and invalid UTF-8 when given bytes. It reads only the
 * fields it verifies; validating the rest against the schema is the caller's. Mirrors the Go
 * `VerifyPaymentRequestJSON`.
 *
 * `expected.depositRequestHashV2Mode` opts it into depositRequestHash v2: the commitment is checked once,
 * over the request as received, as `verifyRequestCommitment` does with the same option, and every
 * signed message is then recovered against the same v1 or v2 candidate. Without it, it is exactly
 * as before v2.
 */
export function verifyPaymentRequestJSON(
  request: string | Uint8Array,
  expected: VerifyPaymentRequestExpectations = {},
): VerifyResult {
  const mode = expected.depositRequestHashV2Mode;
  const checked = checkRequestCommitment(
    request,
    solanaDomainOf(expected),
    commitmentOptionsOf(expected),
    false,
  );
  const text = typeof request === 'string' ? request : decodeUtf8(request);
  const parsed = JSON.parse(text) as PaymentRequest;
  // The commitment check has typed every other field this reads.
  const amount: unknown = parsed.max_source_amount;
  if (amount !== undefined && amount !== null && typeof amount !== 'string') {
    throw new Error(
      'sender_auth: the payment request does not decode: max_source_amount is not a string',
    );
  }
  if (depositRequestHashV2Off(mode)) return verifyTypedPaymentRequest(parsed, expected);
  // The commitment was checked over the text as received; recover every signature against the same
  // v1 or v2 candidate.
  const normalized = withDestination(parsed);
  requireSignedMessages(normalized);
  const verified = recoverAndVerifyEach(normalized, expected, {
    ...commitmentOf(normalized),
    ...(checked.expectedDepositRequestHashV2 !== undefined && {
      depositRequestHashV2: checked.expectedDepositRequestHashV2,
    }),
  });
  return { ...verified, commitment: checked };
}

/**
 * Chain-agnostic sender_auth verifier over a whole PaymentRequest. It first runs the commitment
 * check over the serialized request, so the deposit must commit to the request's own destination
 * and `request_id`. Then, for each signed message, it recovers the signer via the source chain's
 * adapter and requires it to be `source.account`, binds the signed terms to `expected` (token +
 * amount + freshness always; the escrow/roles fail-fast only when supplied), and returns the parsed
 * permits. Recovering the signer refuses a contract-account payer (ERC-1271, such as a Safe), whose
 * signature comes from an owner key; verify its payee with `verifyRequestCommitment`.
 *
 * It checks the object it is given. Parsing keeps one value for a member name that appears twice,
 * so a verifier holding the request text uses {@link verifyPaymentRequestJSON}, and a verifier
 * that forwards the request forwards this same object.
 *
 * **Strict, all-bindable:** every entry in `signed_messages[]` must be a bindable permit; any
 * unbindable or malformed one (e.g. `MalformedPrehashError`) fails the whole request. A consumer
 * with mixed messages (e.g. an EVM setup approval alongside the permit) composes
 * {@link ChainAdapter.recoverSigner} (recover-only) with {@link ChainAdapter.recoverAndVerify}
 * itself instead.
 *
 * **Binding note (read if you did NOT author the request):** by default `token`, `network`,
 * and `amount` are taken from the request itself, so a successful result only proves the
 * signatures are self-consistent with the request's own stated fields. To bind against your
 * agreed terms, pass `sourceAsset` / `network` / `maxSourceAmount` in `expected`; when set,
 * each is used instead of the request-sourced value.
 *
 * This is the *sender_auth* layer only. Request-shape (deadline ordering) and per-consumer
 * policy (budget caps, replay horizons, settlement-routing equality) are the caller's job,
 * layered on top of the returned results.
 *
 * @deprecated Parsing keeps one value for a member name that appears twice, so it checks a copy of
 * the request rather than the text received, and it accepts only depositRequestHash v1: a set
 * `expected.depositRequestHashV2Mode` is refused as `verifier_misconfigured`. Use
 * {@link verifyPaymentRequestJSON} with the request as received.
 */
export function verifyPaymentRequest(
  request: PaymentRequest,
  expected: VerifyPaymentRequestExpectations = {},
): VerifyResult {
  if (!depositRequestHashV2Off(expected.depositRequestHashV2Mode)) {
    return refuse(
      emptyResult(),
      'verifier_misconfigured',
      'verifyPaymentRequest accepts only depositRequestHash v1; use verifyPaymentRequestJSON for depositRequestHashV2',
    );
  }
  return verifyTypedPaymentRequest(request, expected);
}

/** `verifyPaymentRequest`, for `verifyPaymentRequestJSON`'s unopted path. */
function verifyTypedPaymentRequest(
  request: PaymentRequest,
  expected: VerifyPaymentRequestExpectations,
): VerifyResult {
  requireSignedMessages(request);
  const normalized = withDestination(request);
  // The payee check runs first, on the request as serialized: member names that differ only in
  // letter case are refused and every field is read by exact name.
  verifyRequestCommitment(
    serialize(normalized),
    solanaDomainOf(expected),
    commitmentOptionsOf(expected),
  );
  return recoverAndVerifyEach(normalized, expected, commitmentOf(normalized));
}

function requireSignedMessages(request: PaymentRequest): void {
  if (!request.sender_auth?.signed_messages?.length) {
    throw new Error('sender_auth: request has no signed_messages to verify');
  }
}

/**
 * A missing destination list is empty, as in Go, so it is refused as destination_mismatch. The
 * generated type requires at least one leg, which is what the commitment check enforces.
 */
function withDestination(request: PaymentRequest): PaymentRequest {
  return request.destination == null
    ? { ...request, destination: [] as unknown as PaymentRequest['destination'] }
    : request;
}

/** The request's own payee, as the adapters compare it. */
function commitmentOf(request: PaymentRequest): CommitmentExpectation {
  return {
    destinations: request.destination.map((leg) => ({
      asset_identifier: leg.asset_identifier,
      account: leg.account,
    })),
    requestId: request.request_id,
  };
}

/**
 * `verifyPaymentRequest` after the commitment check: recovers and binds every signed message, each
 * against `commitment`. Mirrors the Go `recoverAndVerifyEach`.
 */
function recoverAndVerifyEach(
  request: PaymentRequest,
  expected: VerifyPaymentRequestExpectations,
  commitment: CommitmentExpectation,
): VerifyResult {
  const requestSource = parseSourceAsset(request.source.asset_identifier);
  const {
    sourceAsset,
    network: networkOverride,
    maxSourceAmount: amountOverride,
    depositRequestHashV2Mode: _mode,
    ...scheme
  } = expected;

  // An empty override is unset, as in Go.
  const network = networkOverride || requestSource.network;
  const asset = sourceAsset || requestSource.asset;
  // A quote source amount replaces max_source_amount, so the request's is not read.
  const maxSourceAmount = scheme.quoteSourceAmount
    ? (amountOverride ?? '')
    : amountOverride || (request.max_source_amount ?? '0');

  const source: SourceRef = { network, asset, account: request.source.account };
  const perMessage: VerifyExpectations = { ...scheme, maxSourceAmount };
  const adapter = getChainAdapter(network);
  const results = request.sender_auth!.signed_messages.map((m) =>
    adapter.recoverAndVerify(m as SignedMessageInput, source, commitment, perMessage),
  );

  return { results, recoveredAccount: source.account };
}

/**
 * The commitment options the expectations configure: the v2 mode, and the Stellar escrow, which is
 * the expectations' own `escrowContract`. Undefined when neither is set, so an unopted check is
 * exactly as before.
 */
function commitmentOptionsOf(
  expected: VerifyPaymentRequestExpectations,
): CommitmentOptions | undefined {
  const mode = expected.depositRequestHashV2Mode;
  const options: CommitmentOptions = {
    ...(depositRequestHashV2Off(mode) ? {} : { depositRequestHashV2Mode: mode }),
    ...(expected.escrowContract ? { stellarEscrow: expected.escrowContract } : {}),
  };
  return Object.keys(options).length === 0 ? undefined : options;
}

/** The Solana escrow domain the expectations configure; absent makes a Solana payment verifier_misconfigured. */
function solanaDomainOf(expected: VerifyPaymentRequestExpectations): SolanaDomain | undefined {
  if (expected.svmSignatureDomainVersion === undefined) return undefined;
  return {
    escrowProgramId: expected.escrowContract ?? '',
    clusterId: expected.svmSignatureClusterId ?? '',
    domainVersion: expected.svmSignatureDomainVersion,
    messageScheme: expected.svmMessageScheme,
  };
}

/** The request as JSON text, or "" when it cannot be serialized (which the commitment check refuses). */
function serialize(request: unknown): string {
  try {
    const text = JSON.stringify(request);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}
