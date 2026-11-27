/**
 * The originator-executed (direct) deposit request: the payer funds the escrow itself with
 * approve + directDeposit, then submits a request that names that deposit. Nothing here signs,
 * reads the network, or builds a funding transaction; the wallet that funds the deposit owns that.
 */
import type { SubmitPaymentRequest } from './generated/types.gen';
import type { ChainDefaults } from './chain-adapters';
import { parseAssetIdentifier } from './asset-identifier';
import {
  describeValue,
  isCanonicalPositiveInteger,
  resolveMaxSourceAmount,
} from './max-source-amount';
import {
  InvalidAccountError,
  parse as parseChainAccount,
  validate as validateChainAccount,
} from '@atum-labs/chain-address';
import {
  DirectDepositError as SharedDirectDepositError,
  type DirectDepositReason,
} from '@atum-labs/payment-request-sender-auth';

/** Who performs the payout on the destination chain. The deposit is always the payer's, and the reserve the settler's. */
export type DirectDepositFulfill = 'settler' | 'originator';

/** A direct-deposit request: the body `payments.submitPayment` takes, never carrying sender_auth. */
export type DirectDepositPaymentRequest = Omit<SubmitPaymentRequest, 'sender_auth'>;

/** Everything {@link buildDirectDepositRequest} needs, with the corridor and deadlines already resolved. */
export interface BuildDirectDepositRequestParams {
  version: string;
  depositor: string;
  fulfillmentAmount: string;
  sourceAsset: string;
  destinationAccount: string;
  destinationAsset: string;
  maxSourceAmount: string;
  requestId: string;
  depositNonce: string;
  fulfill: DirectDepositFulfill;
  quoteDeadline: string;
  fulfillmentDeadline: string;
  sourceDefaults: ChainDefaults;
  fulfillmentProxy: string;
  settlerRequirements?: SettlerRequirements;
}

/**
 * The EVM chain id of a direct deposit's source, refusing any source directDeposit cannot pull:
 * only an ERC-20 on an EVM chain.
 */
export function directDepositSourceChainId(sourceAsset: string): bigint {
  // The namespaces are checked on the raw text first, so the parser's own refusals (a wrong token
  // checksum, a malformed address) still reach the caller for an ERC-20 identifier.
  if (!/^eip155:[0-9]+\/erc20:/i.test(sourceAsset)) {
    throw new Error(
      `payment-gateway-client: sourceAsset ${JSON.stringify(sourceAsset)} must be an ERC-20 on an EVM chain: ` +
        'directDeposit pulls only ERC-20 tokens',
    );
  }
  return BigInt(parseAssetIdentifier(sourceAsset).reference);
}

/**
 * The reasons a {@link DirectDepositError} reports: a bounded set, for metric tags. Every reason
 * `deriveDirectDeposit` reports, plus three that only `prepareDirectDepositRequest` reports, each
 * about the depositRequestHash version the gateway publishes for direct deposits from the source
 * chain:
 *
 * - `gateway_version`: you passed a version and the gateway publishes another. Leave
 *   `depositRequestHashVersion` unset to follow the gateway.
 * - `version_unpublished`: the gateway publishes no version and you passed none. Pass the version
 *   the gateway's operator gives you.
 * - `version_unknown`: the gateway publishes a version this build cannot commit. Upgrade the
 *   client.
 */
export type DirectDepositClientReason =
  DirectDepositReason | 'gateway_version' | 'version_unpublished' | 'version_unknown';

/**
 * A direct deposit `deriveDirectDeposit` cannot name, or `prepareDirectDepositRequest` refuses to
 * build. `reason` is one of {@link DirectDepositClientReason}; `detail` says what to change.
 */
export interface DirectDepositError extends Error {
  readonly reason: DirectDepositClientReason;
  readonly detail: string;
}

/**
 * The error class of {@link DirectDepositError}. `deriveDirectDeposit` and
 * `prepareDirectDepositRequest` throw the same class, so one `instanceof DirectDepositError` check
 * catches both.
 */
// The shared class, typed with the client's wider reasons: its reasons mirror the Go derivation's,
// and the three about the gateway's published version belong to this client alone. The runtime
// class is the same, so a derivation error and a client refusal are told apart only by `reason`.
export const DirectDepositError = SharedDirectDepositError as unknown as {
  new (reason: DirectDepositClientReason, detail: string): DirectDepositError;
  readonly prototype: DirectDepositError;
};

/**
 * Refuses a depositRequestHash version passed explicitly that the deposit witness cannot commit,
 * before any network call. Leaving it unset is allowed: the version then comes from the gateway's
 * defaults, see {@link resolveDirectDepositHashVersion}.
 */
export function assertDirectDepositHashVersion(
  version: unknown,
): asserts version is 1 | 2 | undefined {
  if (version !== undefined && version !== 1 && version !== 2) {
    throw new DirectDepositError(
      'version',
      `depositRequestHashVersion must be 1 or 2, got ${describeValue(version)}: leave it unset ` +
        'to use the version the gateway publishes, or pass the one its operator gives you',
    );
  }
}

/**
 * The depositRequestHash version a direct deposit commits, from the version passed and the one the
 * gateway publishes for the source chain, as published. Each deployment derives a direct deposit's
 * id at exactly one version, and a deposit committing any other is accepted on chain under an id no
 * payment names, so nothing here guesses:
 *
 * - a published version other than 1 or 2 is refused whatever was passed (`version_unknown`):
 *   no deposit this build can make commits it;
 * - a passed version that differs from the published one is refused (`gateway_version`);
 * - with nothing published, the passed version is used, and having neither is refused
 *   (`version_unpublished`).
 *
 * JSON null publishes nothing, as it does for every other optional member of the defaults.
 */
export function resolveDirectDepositHashVersion(
  passed: 1 | 2 | undefined,
  published: unknown,
  sourceChainId: string,
): 1 | 2 {
  if (published === undefined || published === null) {
    if (passed === undefined) {
      // Not a default of either version: a gateway that does not publish it may derive at either.
      throw new DirectDepositError(
        'version_unpublished',
        `the gateway does not publish the depositRequestHash version it derives direct deposits ` +
          `from ${sourceChainId} at: pass depositRequestHashVersion as its operator gives it`,
      );
    }
    return passed;
  }
  if (published !== 1 && published !== 2) {
    // Refused even with a version passed: the gateway names the payment at the version it
    // publishes, so a deposit at 1 or 2 would name no payment, as the Permit2 path refuses a
    // version list it cannot sign.
    throw new DirectDepositError(
      'version_unknown',
      `the gateway derives direct deposits from ${sourceChainId} at version ` +
        `${describeValue(published)}, which this build cannot commit: upgrade ` +
        '@atumlabs/payment-gateway-client',
    );
  }
  if (passed !== undefined && passed !== published) {
    throw new DirectDepositError(
      'gateway_version',
      `depositRequestHashVersion is ${passed}, but the gateway derives direct deposits from ` +
        `${sourceChainId} at version ${published}, so this deposit would name no payment: ` +
        'omit depositRequestHashVersion to follow the gateway',
    );
  }
  return published;
}

/** The notice a direct deposit that commits depositRequestHash version 1 carries. */
export interface DirectDepositDeprecation {
  /**
   * Also the `code` of the `DeprecationWarning` the client reports when you passed version 1
   * yourself.
   */
  code: 'ATUM_DIRECT_DEPOSIT_V1';
  /** What to do about it: different when you passed version 1 than when the gateway published it. */
  message: string;
}

/**
 * A fresh notice for a deposit at version 1, so no caller can change another's. `passed` is whether
 * the caller named version 1, which it can change, rather than following the gateway's published
 * version, which moves to version 2 by itself.
 */
export function directDepositV1Deprecation(
  passed: boolean,
  sourceChainId: string,
): DirectDepositDeprecation {
  return {
    code: 'ATUM_DIRECT_DEPOSIT_V1',
    message: passed
      ? 'payment-gateway-client: you passed depositRequestHashVersion 1, which is deprecated for ' +
        'direct deposits and will be retired: leave it unset to follow the gateway where it ' +
        'publishes its version, or pass 2 once your gateway derives at 2'
      : 'payment-gateway-client: this deposit commits depositRequestHash version 1 because the ' +
        `gateway derives direct deposits from ${sourceChainId} at version 1, which is deprecated ` +
        'for direct deposits and will be retired. With depositRequestHashVersion unset there is ' +
        'nothing to change on your side: your deposits move to version 2 when the gateway does.',
  };
}

/** The process members the warning uses, all optional: a browser has no `process` at all. */
interface WarningProcess {
  emitWarning?: (message: string, options: { type: string; code: string }) => void;
  noDeprecation?: boolean;
  throwDeprecation?: boolean;
}

/** The deprecation codes already reported in this process. */
const reportedDeprecations = new Set<string>();

/** Test support: forgets which deprecations were reported. Not exported from the package. */
export function __resetDirectDepositDeprecationsForTests(): void {
  reportedDeprecations.clear();
}

/**
 * Reports a deprecation the caller can act on, once per process for each code, as Node's
 * `util.deprecate` does. In Node it is a `DeprecationWarning` through `process.emitWarning`, which
 * `process.on('warning')` observes. Where `process.emitWarning` is missing (a browser, or a
 * bundler's `process` shim) it goes to `console.warn`. `process.noDeprecation`
 * (`--no-deprecation`) silences it either way.
 *
 * @throws Under `process.throwDeprecation` (`--throw-deprecation`), an `Error` named
 * `DeprecationWarning` with the deprecation's `code`, on every call rather than once.
 */
export function reportDirectDepositDeprecation(deprecation: DirectDepositDeprecation): void {
  const proc = (globalThis as { process?: WarningProcess }).process;
  // As in Node, --no-deprecation wins over --throw-deprecation.
  if (proc?.noDeprecation === true) return;
  if (proc?.throwDeprecation === true) {
    // Node would throw the warning on a later tick, after the prepare resolved with a deposit and
    // out of the caller's reach; thrown here, the prepare rejects before returning one. Every time:
    // a caller that catches it must not get a deposit at version 1 by asking again.
    const warning = new Error(deprecation.message) as Error & { code: string };
    warning.name = 'DeprecationWarning';
    warning.code = deprecation.code;
    throw warning;
  }
  if (reportedDeprecations.has(deprecation.code)) return;
  reportedDeprecations.add(deprecation.code);
  if (typeof proc?.emitWarning === 'function') {
    proc.emitWarning(deprecation.message, { type: 'DeprecationWarning', code: deprecation.code });
    return;
  }
  globalThis.console?.warn?.(`DeprecationWarning [${deprecation.code}]: ${deprecation.message}`);
}

/** The RFC 9562 version 4 layout, which `randomUUID()` returns: 122 random bits. */
const RANDOM_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Refuses a version 1 `requestId` that is not a random UUID. At version 1 the deposit commits
 * only the hash of `request_id`, so the id is all that keeps the request's other terms from
 * being chosen by someone else; an order number, a composite key or a time-based UUID can be
 * guessed. No format proves randomness, but this one refuses the ids people reach for by habit.
 * Version 2 commits the whole request, so any id the request pattern admits is fine there.
 */
export function assertDirectDepositRequestId(version: 1 | 2, requestId: string): void {
  if (version === 1 && !RANDOM_UUID_PATTERN.test(requestId)) {
    throw new DirectDepositError(
      'request',
      `at depositRequestHashVersion 1 the requestId must be a random UUID from randomUUID(), got ${JSON.stringify(requestId)}: ` +
        'the deposit commits only its hash, so it has to be unguessable',
    );
  }
}

/**
 * Refuses a missing deadline window. Both are required on this path: the right quote window
 * depends on when the request is built relative to funding and finality, so no default fits, and
 * a fulfillment default shorter than a caller's quote window would refuse a request the caller
 * never meant to shorten.
 */
export function assertDirectDepositWindows(params: {
  quoteDeadlineSeconds?: number;
  fulfillmentDeadlineSeconds?: number;
}): void {
  for (const name of ['quoteDeadlineSeconds', 'fulfillmentDeadlineSeconds'] as const) {
    if (params[name] === undefined) {
      throw new Error(
        `payment-gateway-client: ${name} is required for a direct deposit: submit only after the ` +
          'deposit is final, with a short quote window remaining, and the fulfillment window must outlast it',
      );
    }
  }
}

/**
 * Refuses stamped deadlines that are not in order. They are written to the millisecond, so
 * windows less than a millisecond apart can stamp equal deadlines, which the gateway refuses
 * after the payer funded.
 */
export function assertOrderedDeadlines(deadlines: {
  quote_deadline: string;
  fulfillment_deadline: string;
}): void {
  if (Date.parse(deadlines.fulfillment_deadline) <= Date.parse(deadlines.quote_deadline)) {
    throw new Error(
      'payment-gateway-client: the fulfillment deadline must be later than the quote deadline once both ' +
        'are written to the millisecond: make fulfillmentDeadlineSeconds at least a millisecond longer',
    );
  }
}

/**
 * Refuses an EVM address the gateway refuses after the payer funded: malformed, surrounded by
 * whitespace, or mixed case with a wrong EIP-55 checksum (all-lowercase and all-uppercase carry
 * no checksum and pass). `allowZero` leaves the zero address to the shared rules, which refuse it
 * with a typed rule error. The typed {@link InvalidAccountError} is the thrown error's `cause`.
 */
export function assertEvmAccount(
  label: string,
  network: string,
  address: string,
  options: { allowZero?: boolean } = {},
): void {
  // Mirrors a gateway check the shared PaymentRequest rules do not carry yet; once they do, this
  // can go and the shared rules refuse it.
  try {
    if (options.allowZero) parseChainAccount(network, address);
    else validateChainAccount(network, address);
  } catch (error) {
    if (!(error instanceof InvalidAccountError)) throw error;
    throw new Error(
      `payment-gateway-client: ${label} ${JSON.stringify(address)}: ${error.message}`,
      { cause: error },
    );
  }
}

/**
 * Refuses a fulfillment verifier endpoint the gateway refuses after the payer funded: it must be
 * an absolute http or https URL with a host. Fetched defaults always pass; this catches a value
 * supplied offline.
 */
export function assertVerifierEndpoint(endpoint: string): void {
  // The URL parser here forgives spellings the gateway's does not (no '//', a backslash, spaces
  // or control characters it strips, escapes in the host, a stray '%'), so the written form is
  // held to the strict shape first: a plain host, and every '%' starting a valid escape.
  const hasControlOrSpace = Array.from(endpoint).some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x20 || code === 0x7f || /\s/.test(char);
  });
  let url: URL | undefined;
  try {
    url =
      hasControlOrSpace ||
      !/^https?:\/\/[A-Za-z0-9.\-[\]:@]+(?=[/?#]|$)/i.test(endpoint) ||
      /%(?![0-9A-Fa-f]{2})/.test(endpoint)
        ? undefined
        : new URL(endpoint);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') {
    throw new Error(
      `payment-gateway-client: the fulfillment verifier endpoint ${JSON.stringify(endpoint)} must be an ` +
        'absolute http(s) URL with a host',
    );
  }
}

/** Optional settler allow/deny lists, as the PaymentRequest carries them. */
export type SettlerRequirements = NonNullable<SubmitPaymentRequest['settler_requirements']>;

const SETTLER_DID = /^did:[a-z][a-z0-9]*:[a-zA-Z0-9._:%-]+$/;
const MAX_SETTLER_LIST = 100;

/**
 * Refuses settler lists the PaymentRequest schema refuses: each present list holds 1 to 100
 * distinct DIDs. The gateway checks the schema only after the payer funded.
 */
export function assertSettlerRequirements(requirements: SettlerRequirements | undefined): void {
  if (requirements === undefined) return;
  for (const name of ['whitelist', 'blacklist'] as const) {
    const list = requirements[name];
    if (list === undefined) continue;
    const refuse = (why: string): never => {
      throw new Error(`payment-gateway-client: settlerRequirements.${name} ${why}`);
    };
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_SETTLER_LIST) {
      refuse(`must hold 1 to ${MAX_SETTLER_LIST} settler DIDs`);
    }
    if (new Set(list).size !== list.length) refuse('must not repeat an entry');
    const bad = list.find((entry) => typeof entry !== 'string' || !SETTLER_DID.test(entry));
    if (bad !== undefined) refuse(`entry ${JSON.stringify(bad)} is not a DID`);
  }
}

/** The largest fulfillment amount the gateway admits. */
const MAX_FULFILLMENT_AMOUNT = 10n ** 30n;

/**
 * Refuses a fulfillment amount the gateway would refuse after the payer funded: canonical decimal
 * digits only (no sign, spaces or leading zeros), positive, and at most 10^30.
 */
export function assertDirectDepositFulfillmentAmount(fulfillmentAmount: unknown): void {
  // The 10^30 bound mirrors a gateway check the shared PaymentRequest rules do not carry yet.
  if (
    !isCanonicalPositiveInteger(fulfillmentAmount) ||
    BigInt(fulfillmentAmount) > MAX_FULFILLMENT_AMOUNT
  ) {
    throw new Error(
      `payment-gateway-client: fulfillmentAmount must be a positive base-10 integer of at most 10^30 ` +
        `with no leading zeros, got ${describeValue(fulfillmentAmount)}`,
    );
  }
}

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * The deposit amount (`max_source_amount`), validated as the spend cap is on the Permit2 path and
 * bounded to the uint256 directDeposit takes.
 */
export function directDepositAmount(
  maxSourceAmount: string,
  corridor: { sourceAsset: string; destinationAsset: string },
): string {
  const amount = resolveMaxSourceAmount(maxSourceAmount, 'required', corridor);
  if (BigInt(amount) > MAX_UINT256) {
    throw new Error(
      `payment-gateway-client: maxSourceAmount must fit in uint256, the amount directDeposit takes, got ${amount}`,
    );
  }
  return amount;
}

/**
 * The `deposit_nonce` member for a caller's nonce, refusing one directDeposit cannot take: a
 * decimal string or bigint in uint256.
 */
export function directDepositNonce(depositNonce: bigint | string): string {
  const valid =
    typeof depositNonce === 'bigint'
      ? depositNonce >= 0n && depositNonce <= MAX_UINT256
      : typeof depositNonce === 'string' &&
        /^[0-9]+$/.test(depositNonce) &&
        BigInt(depositNonce) <= MAX_UINT256;
  if (!valid) {
    throw new Error(
      `payment-gateway-client: depositNonce must be a decimal uint256 (a string of digits or a bigint), got ` +
        `${typeof depositNonce === 'bigint' ? `${depositNonce}n` : JSON.stringify(depositNonce)}`,
    );
  }
  // Canonical decimal, so a rebuild with '007' or 7n writes the same bytes as '7'.
  return BigInt(depositNonce).toString();
}

/** Builds the request body with no network access. */
export function buildDirectDepositRequest(
  params: BuildDirectDepositRequestParams,
): DirectDepositPaymentRequest {
  const source = parseAssetIdentifier(params.sourceAsset);
  const destination = parseAssetIdentifier(params.destinationAsset);
  return {
    version: params.version,
    request_id: params.requestId,
    source: { asset_identifier: source.normalized, account: params.depositor },
    destination: [{ asset_identifier: destination.normalized, account: params.destinationAccount }],
    fulfillment_amount: params.fulfillmentAmount,
    max_source_amount: params.maxSourceAmount,
    quote_deadline: params.quoteDeadline,
    fulfillment_deadline: params.fulfillmentDeadline,
    escrow_contract_address: params.sourceDefaults.escrowContract,
    quote_selector: params.sourceDefaults.quoteSelector,
    fulfillment_verifier: {
      account: params.sourceDefaults.fulfillmentVerifierAccount,
      endpoint: params.sourceDefaults.fulfillmentVerifierEndpoint,
    },
    fulfillment_proxy: params.fulfillmentProxy,
    executor: { deposit: 'originator', reserve: 'settler', fulfill: params.fulfill },
    deposit_nonce: params.depositNonce,
    ...(params.settlerRequirements ? { settler_requirements: params.settlerRequirements } : {}),
  };
}
