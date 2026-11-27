/**
 * atum-escrow server mechanism — the resource-server (merchant) side.
 *
 * Implements the x402 SchemeNetworkServer for the `atum-escrow` scheme:
 *   - parsePrice turns the merchant's receive-side amount into the source-side cap:
 *     fulfillmentAmount plus markup, converted into the atomic units of the source token the
 *     payer will fund.
 *   - enhancePaymentRequirements points `payTo` at the source escrow (funds lock in
 *     escrow, not with the merchant) and attaches the `extra.atum` block — the
 *     receive-side destination, contract/role addresses, and deadline budgets the
 *     client needs to build the payment locally, with no gateway round-trip.
 *   - enrichPaymentRequiredResponse declares the standard `payment-identifier`
 *     extension, so a payer knows it must name the purchase it is paying for, and adds
 *     `extra.atumResource`, the page the payment is bound to.
 *
 * The merchant's receive-side and the corridor addresses are configuration, not
 * derived from the price string, so the scheme is constructed with them.
 */

import { z } from 'zod';
import { publishedDepositRequestHashVersions } from '@atum-labs/payment-request-sender-auth';
import type {
  SchemeNetworkServer,
  Price,
  Network,
  AssetAmount,
  PaymentRequirements,
  SchemePaymentRequiredContext,
} from '@x402/core/types';
import { caipEqual, formatZodError } from '../internal';
import { DEFAULT_PEG_GROUPS, comparable } from '../peg';
import { MAX_TOKEN_DECIMALS, maxSourceAmount } from '../source-cap';
import type { AtumEscrowExtra } from '../contract';
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifier,
  type PaymentIdentifierExtension,
} from '../payment-identifier';
import {
  ATUM_RESOURCE_EXTRA_KEY,
  ATUM_RESOURCE_MAX_LENGTH,
  atumEscrowCanonicalQuery,
  atumEscrowResource,
  hasAtumResource,
  isValidAtumResource,
} from '../request-id';

const ATUM_ESCROW_SCHEME = 'atum-escrow';

/** The HTTP request fields core passes in `transportContext.request`, when the 402 is for HTTP. */
interface HttpRequestLike {
  method?: unknown;
  path?: unknown;
  adapter?: { getUrl?: unknown; getQueryParams?: unknown; getHeader?: unknown };
}

/** The part of `url` after `://` plus the Host header, so a `?` in the Host is not read as a query. */
function afterHost(adapter: { getHeader?: unknown }, url: string): string {
  const host =
    typeof adapter.getHeader === 'function'
      ? (adapter.getHeader as (name: string) => unknown).call(adapter, 'host')
      : undefined;
  if (typeof host !== 'string' || host === '') return url;
  // Cut only right after the scheme; any other layout keeps the whole URL, which fails closed.
  const at = url.indexOf('://');
  return at >= 0 && url.startsWith(host, at + 3) ? url.slice(at + 3 + host.length) : url;
}

/**
 * The page a 402 is for, as published in `extra.atumResource`. Over HTTP it is the path core
 * routed on plus the canonical form of the parsed query; otherwise it is `resourceInfo.url`.
 */
function resourceOf(context: SchemePaymentRequiredContext): string {
  const request = (context.transportContext as { request?: HttpRequestLike } | undefined)?.request;
  const adapter = request?.adapter;
  let resource: string;
  if (
    typeof request?.method === 'string' &&
    typeof request.path === 'string' &&
    adapter !== null &&
    typeof adapter === 'object'
  ) {
    if (typeof adapter.getQueryParams !== 'function') {
      throw new Error(
        'atum-escrow: cannot bind the 402 to its page: the HTTP adapter has no getQueryParams',
      );
    }
    const query = atumEscrowCanonicalQuery((adapter.getQueryParams as () => unknown).call(adapter));
    // getUrl() is steerable by headers, so it is only used to refuse, never to build the page.
    const url =
      typeof adapter.getUrl === 'function' ? (adapter.getUrl as () => unknown).call(adapter) : '';
    if (query === '' && typeof url === 'string' && /\?[^#]*[^&#]/.test(afterHost(adapter, url))) {
      throw new Error(
        'atum-escrow: cannot bind the 402 to its page: the URL has a query but none was parsed',
      );
    }
    resource = atumEscrowResource(request.method, request.path, query);
  } else {
    resource = context.resourceInfo?.url ?? '';
  }
  if (!isValidAtumResource(resource)) {
    throw new Error(
      `atum-escrow: cannot bind the 402 to its page: the resource must be 1 to ${ATUM_RESOURCE_MAX_LENGTH} UTF-8 bytes`,
    );
  }
  return resource;
}

/**
 * One source chain the merchant accepts payment from.
 *
 * @public
 */
export interface AtumEscrowSource {
  /** Source token contract the payer funds with, on this network. */
  asset: string;
  /** Source-chain escrow contract; funds lock here, and it is the x402 `payTo` for this option. */
  escrow: string;
  /** Ticker of the source token, compared with the destination's to establish they are the same money. */
  symbol: string;
  /** Decimals of the source token: the unit its atomic amounts are counted in. */
  decimals: number;
  /**
   * Solana source only: cluster name for the V3 escrow signature domain. Lives on the
   * source (not the merchant top level) because it is a property of the source chain's
   * escrow — a merchant accepting from several chains has a different domain per source.
   */
  svmSignatureClusterId?: string;
  /** Solana source only: escrow signature-domain version. */
  svmSignatureDomainVersion?: number;
  /**
   * The depositRequestHash versions a payer may sign for this source, published as
   * `extra.atum.depositRequestHashVersions`: 1 is keccak256 of the request_id, 2 is the hash of the
   * payment terms. Absent publishes nothing, which payers read as `[1]`. Set it only once every payer
   * you serve and your facilitator run a release that knows the field: an older client or facilitator
   * refuses a requirement carrying it, even `[1]`. List what the payment gateway's `GET /v1/defaults`
   * lists for this source chain, exactly as it lists them.
   * {@link depositRequestHashVersionsFromDefaults} derives it. Unset it before rolling a client or
   * facilitator back.
   */
  depositRequestHashVersions?: number[];
}

/**
 * Corridor configuration for {@link AtumEscrowServerScheme}. The merchant's
 * receive-side and the corridor's contract/role addresses are supplied here
 * rather than derived from the route price.
 *
 * @public
 */
export interface AtumEscrowServerConfig {
  /**
   * Where the merchant receives: CAIP-2 chain, token contract and receive address, plus the
   * token's ticker and decimals. Only the chain, token and address reach the 402.
   */
  destination: {
    network: string;
    asset: string;
    address: string;
    symbol: string;
    decimals: number;
  };
  /** Exact amount the merchant receives, in atomic units of the destination token. */
  fulfillmentAmount: string;
  /** Markup added over `fulfillmentAmount` to derive each source cap, in basis points (e.g. `300` = 3%). */
  markupBps: number;
  /** Destination-chain fulfillment proxy contract. */
  fulfillmentProxy: string;
  /** Atum reserver role address (an escrow-deposit witness; equals the source `quote_selector`). */
  reserver: string;
  /** Atum releaser role address (an escrow-deposit witness; equals the source `fulfillment_verifier` account). */
  releaser: string;
  /** Source-chain fulfillment-verifier (veri-fill) endpoint the client carries into the request. */
  fulfillmentVerifierEndpoint: string;
  /**
   * Recommended quote-deadline budget in seconds, counted from when the payer builds the payment.
   * Bidding closes at the quote deadline, so the payment must reach the network with time left to
   * bid. Before it does, it is signed, sent to you, verified, and settled once your route handler
   * has responded. About 3 seconds covers that for a handler that answers in a few hundred
   * milliseconds; add your handler's typical run time on top. The payer's clock skew also comes
   * out of this budget, and only you can widen it.
   */
  quoteDeadlineSeconds: number;
  /** Recommended fulfillment-deadline budget in seconds, counted from when the payer builds the payment. */
  fulfillmentDeadlineSeconds: number;
  /** Source options the merchant accepts, keyed by CAIP-2 source network. */
  sources: Record<string, AtumEscrowSource>;
  /**
   * Groups of token symbols treated as the same money. Replaces the default, which is the same
   * `DEFAULT_PEG_GROUPS` the payer client uses when its payer sets none; match the groups your
   * payers use, or a corridor this server accepts is one they refuse.
   */
  pegGroups?: ReadonlyArray<ReadonlyArray<string>>;
  /**
   * Wall-clock source, in epoch milliseconds. Defaults to `Date.now`.
   *
   * @deprecated Nothing in a requirement is derived from it, so supplying it has no effect.
   * Every field of `extra.atum` must be reproducible by a later rebuild — the resource server
   * rebuilds the block on the paid request and x402 compares it against the payer's echo — and
   * a clock reading is not. Retained only so a merchant already passing it still compiles;
   * expect it to be removed in a later major version.
   */
  now?: () => number;
}

// EVM 0x-hex, base58 (Solana/Tron) OR a Stellar strkey (`G…` account, `C…` contract) — the scheme is
// any-source to any-destination, so addresses take their chain's form. This is the wire schema's
// chainAddress. The address pattern is the only gate here: the network is checked for its CAIP-2
// shape and nothing more, so an address in the wrong chain's form is caught when the chain's
// adapter and the trust source see it, not at construction.
const CHAIN_ADDRESS = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|[GC][A-Z2-7]{55})$/;
/** The longest a Stellar deposit's deadline can lie after its issue time (the escrow's own bound). */
const STELLAR_MAX_FULFILLMENT_DEADLINE_SECS = 86_400;
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const AMOUNT = /^[0-9]+$/;
const SYMBOL = z.string().min(1);
const DECIMALS = z.number().int().min(0).max(MAX_TOKEN_DECIMALS);

/**
 * Runtime validation of the corridor config: a misconfigured merchant fails loudly
 * at construction rather than emitting a malformed 402. Config is operator input,
 * not a wire type, so it has no JSON Schema — Zod is the right tool here. Assigning
 * the parsed result to an {@link AtumEscrowServerConfig}-typed field also makes the
 * compiler check this schema against the interface, so the two cannot drift.
 */
const ConfigSchema = z
  .object({
    destination: z.object({
      network: z.string().regex(CAIP2),
      asset: z.string().regex(CHAIN_ADDRESS),
      address: z.string().regex(CHAIN_ADDRESS),
      symbol: SYMBOL,
      decimals: DECIMALS,
    }),
    fulfillmentAmount: z.string().regex(AMOUNT),
    markupBps: z.number().int().min(0),
    fulfillmentProxy: z.string().regex(CHAIN_ADDRESS),
    reserver: z.string().regex(CHAIN_ADDRESS),
    releaser: z.string().regex(CHAIN_ADDRESS),
    fulfillmentVerifierEndpoint: z.string().url(),
    quoteDeadlineSeconds: z.number().int().positive(),
    fulfillmentDeadlineSeconds: z.number().int().positive(),
    sources: z.record(
      z.string().regex(CAIP2),
      z.object({
        asset: z.string().regex(CHAIN_ADDRESS),
        escrow: z.string().regex(CHAIN_ADDRESS),
        symbol: SYMBOL,
        decimals: DECIMALS,
        // Solana sources only: the escrow signature-domain (V3). Absent for EVM/Tron.
        svmSignatureClusterId: z.string().optional(),
        svmSignatureDomainVersion: z.number().int().min(1).max(255).optional(),
        // As extra.atum's schema: at least one version, each a positive integer, none repeated.
        depositRequestHashVersions: z
          .array(z.number().int().min(1))
          .nonempty()
          .refine((versions) => new Set(versions).size === versions.length, {
            message: 'depositRequestHashVersions must not repeat a version',
          })
          .optional(),
      }),
    ),
    pegGroups: z.array(z.array(SYMBOL)).optional(),
  })
  // Relationship checks the per-field shapes above cannot express — caught at construction
  // (boot) so a misconfigured merchant fails fast with an actionable error, instead of
  // booting, serving 402s, and having every payment fail downstream.
  .refine((c) => c.quoteDeadlineSeconds < c.fulfillmentDeadlineSeconds, {
    message: 'quoteDeadlineSeconds must be strictly less than fulfillmentDeadlineSeconds',
    path: ['quoteDeadlineSeconds'],
  })
  .superRefine((c, ctx) => {
    // A solana: source must carry its escrow signature-domain (cluster id + version), or it
    // serves 402s every client rejects with "Solana source requires svm_signature_cluster_id…".
    // The fields are optional on the shape (EVM/Tron omit them), so this solana-only
    // requirement is a relationship check, not a per-field one.
    for (const [network, source] of Object.entries(c.sources)) {
      if (
        network.split(':')[0] === 'solana' &&
        (source.svmSignatureClusterId === undefined ||
          source.svmSignatureDomainVersion === undefined)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Solana source ${network} requires svmSignatureClusterId and svmSignatureDomainVersion`,
          path: ['sources', network],
        });
      }
      // A Stellar deposit's deadline is the fulfillment deadline, and the escrow accepts only
      // `deadline - issued_at` of at most a day, so no payer can sign one for a longer budget.
      // The bound is the day itself: `issued_at` trails the ledger a little, so a budget just
      // under a day can still be refused by the payer's client when it builds the deposit.
      if (
        network.split(':')[0] === 'stellar' &&
        c.fulfillmentDeadlineSeconds > STELLAR_MAX_FULFILLMENT_DEADLINE_SECS
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `fulfillmentDeadlineSeconds must be at most ${STELLAR_MAX_FULFILLMENT_DEADLINE_SECS} (a day) for Stellar source ${network}: the escrow refuses a deposit whose deadline is further than a day from its issue time`,
          path: ['fulfillmentDeadlineSeconds'],
        });
      }
    }
  });

/**
 * Why the server refused its config. `INVALID_CONFIG` is a malformed field (the message names its
 * path); `ASSETS_NOT_COMPARABLE` is a source token that is not the same money as the destination;
 * `CAP_BELOW_PRICE` is a source whose cap, rounded down to a whole atomic unit, is worth less than
 * the fulfillment, so every fill would lose money and no settler would take it; `PRICE_CONFLICT`
 * is a route price that does not restate the corridor's fulfillment; `SOURCE_NOT_CONFIGURED` is a
 * route on a network the config offers no source for.
 *
 * @public
 */
export type AtumEscrowConfigErrorCode =
  | 'INVALID_CONFIG'
  | 'ASSETS_NOT_COMPARABLE'
  | 'CAP_BELOW_PRICE'
  | 'PRICE_CONFLICT'
  | 'SOURCE_NOT_CONFIGURED';

/**
 * Thrown by {@link AtumEscrowServerScheme} for a config that cannot serve payers.
 * `INVALID_CONFIG`, `ASSETS_NOT_COMPARABLE` and `CAP_BELOW_PRICE` are thrown at construction, so
 * the merchant fails at boot. `PRICE_CONFLICT` and `SOURCE_NOT_CONFIGURED` are thrown when a route
 * is priced: x402 never prices a route at boot, so a route whose price does not restate the
 * corridor, or whose network has no configured source, fails on its first request (an HTTP adapter
 * answers it with an error status) while the rest of the server keeps serving.
 *
 * @public
 */
export class AtumEscrowConfigError extends Error {
  readonly code: AtumEscrowConfigErrorCode;
  /** The network at fault: the source for `ASSETS_NOT_COMPARABLE` and `CAP_BELOW_PRICE`, the
   * priced network for `PRICE_CONFLICT` and `SOURCE_NOT_CONFIGURED`. */
  readonly network?: string;

  constructor(init: { code: AtumEscrowConfigErrorCode; message: string; network?: string }) {
    super(init.message);
    this.name = 'AtumEscrowConfigError';
    this.code = init.code;
    this.network = init.network;
  }
}

/**
 * The {@link AtumEscrowSource.depositRequestHashVersions} for a source, from its chain's entry in
 * the payment gateway's `GET /v1/defaults` (what `PaymentGatewayClient.fetchChainDefaults` returns):
 * the versions the gateway lists, exactly as it lists them, or `undefined`, which publishes nothing,
 * while it lists only version 1.
 *
 * @example
 * ```ts
 * const defaults = await gateway.fetchChainDefaults(network);
 * const source = { ...base, depositRequestHashVersions: depositRequestHashVersionsFromDefaults(network, defaults) };
 * ```
 *
 * @throws {AtumEscrowConfigError} `INVALID_CONFIG` when the gateway lists no version this build
 *   signs for the chain, so every payment would be refused, or a list that is not one.
 * @public
 */
export function depositRequestHashVersionsFromDefaults(
  network: string,
  defaults: {
    depositRequestHashVersion?: number | null;
    depositRequestHashVersions?: readonly number[] | null;
  },
): number[] | undefined {
  try {
    return publishedDepositRequestHashVersions(defaults);
  } catch (err) {
    throw new AtumEscrowConfigError({
      code: 'INVALID_CONFIG',
      message: `the payment gateway's depositRequestHash versions for ${network} cannot be published: ${(err as Error).message}`,
      network,
    });
  }
}

/**
 * The route price for a corridor: exactly what the merchant receives, as the destination token
 * and its atomic amount. A route priced with it cannot conflict with the scheme's config, because
 * it is derived from that config rather than restated beside it.
 *
 * @example
 * ```ts
 * const routes = { "GET /paid": { accepts: { scheme: "atum-escrow", network, payTo, price: atumEscrowPrice(config) } } };
 * ```
 *
 * @public
 */
export function atumEscrowPrice(config: {
  destination: { asset: string };
  fulfillmentAmount: string;
}): AssetAmount {
  return { asset: config.destination.asset, amount: config.fulfillmentAmount };
}

/**
 * A route price as text for an error message. A price that cannot be serialized (a bigint, a
 * cycle) still has to produce the PRICE_CONFLICT error rather than a bare TypeError.
 */
function describePrice(price: unknown): string {
  try {
    return (
      JSON.stringify(price, (_key, value: unknown) =>
        typeof value === 'bigint' ? `${value}n` : value,
      ) ?? String(price)
    );
  } catch {
    return String(price);
  }
}

/** The source cap for one source option, in that source token's atomic units. */
function capFor(config: AtumEscrowServerConfig, source: AtumEscrowSource): bigint {
  return maxSourceAmount({
    fulfillmentAmount: config.fulfillmentAmount,
    markupBps: config.markupBps,
    sourceDecimals: source.decimals,
    destinationDecimals: config.destination.decimals,
  });
}

/**
 * The resource-server (merchant) side of the `atum-escrow` x402 scheme.
 *
 * Register one instance per corridor into an `x402ResourceServer`; it produces the
 * scheme-specific parts of the `402`: the source-side spend cap (the configured
 * receive amount plus a markup, in the source token's units), `payTo` pointing at
 * the source escrow, and the `extra.atum` block the client reads to build the
 * payment locally.
 *
 * @example
 * ```ts
 * import { x402ResourceServer } from "@x402/core/server";
 * import { AtumEscrowServerScheme } from "@atumlabs/x402-atum-escrow/server";
 *
 * const scheme = new AtumEscrowServerScheme({
 *   destination: {
 *     network: "eip155:42161",
 *     asset: "0x…USDC",
 *     address: "0x…merchant",
 *     symbol: "USDC",
 *     decimals: 6,
 *   },
 *   fulfillmentAmount: "10000000",
 *   markupBps: 300,
 *   fulfillmentProxy: "0x…proxy",
 *   reserver: "0x…reserver",
 *   releaser: "0x…releaser",
 *   quoteDeadlineSeconds: 3,
 *   fulfillmentDeadlineSeconds: 300,
 *   sources: {
 *     "eip155:8453": { asset: "0x…baseUSDC", escrow: "0x…escrow", symbol: "USDC", decimals: 6 },
 *   },
 * });
 *
 * const server = new x402ResourceServer(facilitatorClient);
 * server.register("eip155:8453", scheme);
 * ```
 *
 * @public
 */
export class AtumEscrowServerScheme implements SchemeNetworkServer {
  readonly scheme = ATUM_ESCROW_SCHEME;

  private readonly config: AtumEscrowServerConfig;
  private readonly now: () => number;

  /**
   * @param config - the corridor this scheme instance serves (receive-side,
   *   markup, contract/role addresses, and the accepted source options)
   * @throws {@link AtumEscrowConfigError} `INVALID_CONFIG` if the config is malformed (invalid
   *   address, non-positive deadline, missing token decimals, …), `ASSETS_NOT_COMPARABLE` if a
   *   source token is not the same money as the destination token, or `CAP_BELOW_PRICE` if a
   *   source's cap would be worth less than the fulfillment
   */
  constructor(config: AtumEscrowServerConfig) {
    const result = ConfigSchema.safeParse(config);
    if (!result.success) {
      throw new AtumEscrowConfigError({
        code: 'INVALID_CONFIG',
        message: `invalid atum-escrow server config: ${formatZodError(result.error)}`,
      });
    }
    const pegGroups = result.data.pegGroups ?? DEFAULT_PEG_GROUPS;
    const destination = result.data.destination;
    for (const [network, source] of Object.entries(result.data.sources)) {
      if (!comparable(source.symbol, destination.symbol, pegGroups)) {
        throw new AtumEscrowConfigError({
          code: 'ASSETS_NOT_COMPARABLE',
          network,
          message: `atum-escrow: source ${source.symbol} on ${network} is not the same money as destination ${destination.symbol} on ${destination.network}, so payers would refuse to price it`,
        });
      }
    }
    // Rounding the cap down protects the payer, but with fewer source than destination decimals
    // it can land below the price itself, and a cap no settler can fill fails every payment.
    const fulfillment = BigInt(result.data.fulfillmentAmount);
    for (const [network, source] of Object.entries(result.data.sources)) {
      const cap = capFor(result.data, source);
      if (
        cap * 10n ** BigInt(destination.decimals) <
        fulfillment * 10n ** BigInt(source.decimals)
      ) {
        throw new AtumEscrowConfigError({
          code: 'CAP_BELOW_PRICE',
          network,
          message: `atum-escrow: the cap for source ${network} rounds to ${cap} atomic units of ${source.symbol}, worth less than the fulfillment of ${result.data.fulfillmentAmount} atomic units of ${destination.symbol}`,
        });
      }
    }
    this.config = result.data;
    // `now` is a function, not wire data, so it is captured here rather than through
    // ConfigSchema (which would strip it).
    this.now = config.now ?? (() => Date.now());
  }

  /** Resolve the configured source option for a network, or throw if none is offered. */
  private sourceFor(network: string): AtumEscrowSource {
    const source = this.config.sources[network];
    if (!source) {
      throw new AtumEscrowConfigError({
        code: 'SOURCE_NOT_CONFIGURED',
        network,
        message: `atum-escrow: no source option configured for network ${network}`,
      });
    }
    return source;
  }

  /**
   * Convert the merchant's receive amount into the source-side spend cap.
   *
   * @remarks
   * For `atum-escrow` the authoritative receive amount is `config.fulfillmentAmount`, so the
   * route `price` must restate it — {@link atumEscrowPrice} builds exactly that — and anything
   * else is refused rather than silently overridden. A dollar price is refused too: converting
   * it would assume the destination token's value.
   *
   * The source cap is `fulfillmentAmount + markup`, converted from destination to source atomic
   * units and rounded down — the same arithmetic the payer's client bounds the cap with, so a
   * markup within the payer's allowance passes whenever the decimals declared here match the
   * ones the payer's trust source reports.
   *
   * @param price - the route price; must equal {@link atumEscrowPrice} of this config
   * @param network - the CAIP-2 source network the cap is quoted for
   * @returns the source asset and the atomic spend-cap amount
   * @throws {@link AtumEscrowConfigError} `SOURCE_NOT_CONFIGURED` if no source option is
   *   configured for `network`, or `PRICE_CONFLICT` if `price` does not restate the corridor's
   *   fulfillment
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    const source = this.sourceFor(network);
    if (!this.restatesFulfillment(price)) {
      const { destination, fulfillmentAmount } = this.config;
      throw new AtumEscrowConfigError({
        code: 'PRICE_CONFLICT',
        network,
        message: `atum-escrow: the route price for ${network} must be atumEscrowPrice(config), ${fulfillmentAmount} of ${destination.asset} on ${destination.network}; got ${describePrice(price)}`,
      });
    }
    return {
      asset: source.asset,
      amount: capFor(this.config, source).toString(),
    };
  }

  /**
   * Whether a route price is exactly the corridor's fulfillment. Core reads only a price's
   * `asset` and `amount`, so anything else on it — an `extra` included — would be dropped
   * silently, and is refused instead.
   */
  private restatesFulfillment(price: Price): boolean {
    if (typeof price !== 'object' || price === null) return false;
    const { destination, fulfillmentAmount } = this.config;
    return (
      Object.keys(price).every((key) => key === 'asset' || key === 'amount' || key === 'extra') &&
      price.extra === undefined &&
      typeof price.asset === 'string' &&
      caipEqual(destination.network, price.asset, destination.asset) &&
      price.amount === fulfillmentAmount
    );
  }

  /**
   * The decimals of a configured token, so `@x402/core` reads this scheme's amounts (a settlement
   * override, the paywall's display amount) in the token's own units instead of assuming 6.
   *
   * @param asset - a configured source or destination token address
   * @param network - the CAIP-2 network that token is configured on
   * @returns the decimals declared for that token
   * @throws if no configured token matches, rather than guessing a unit
   */
  getAssetDecimals(asset: string, network: string): number {
    const source = this.config.sources[network];
    if (source !== undefined && caipEqual(network, source.asset, asset)) {
      return source.decimals;
    }
    // Core asks only about a requirement this scheme priced, whose asset is always a configured
    // source; the destination is answered for callers that use this method directly.
    const destination = this.config.destination;
    if (destination.network === network && caipEqual(network, destination.asset, asset)) {
      return destination.decimals;
    }
    throw new Error(`atum-escrow: no configured token ${asset} on network ${network}`);
  }

  /**
   * Point `payTo` at the source escrow and attach the `extra.atum` block.
   *
   * @remarks
   * The base requirement already carries `network`, `asset`, and `amount` (from
   * {@link AtumEscrowServerScheme.parsePrice}); this sets `payTo` to the escrow — funds
   * lock in escrow, not with the merchant — and adds the corridor data the payer needs to
   * build and sign the payment locally, with no gateway round-trip.
   *
   * Everything in the block is configuration, so it is built here, once per requirement, and a
   * rebuild reproduces it exactly. The inbound `extra` is spread rather than replaced, so
   * a route-level `extra` supplied by the merchant survives into the 402.
   *
   * @param paymentRequirements - the base requirement to enhance
   * @returns the requirement with `payTo` set and `extra.atum` attached
   * @throws {@link AtumEscrowConfigError} `SOURCE_NOT_CONFIGURED` if no source option is
   *   configured for the requirement's network
   */
  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentRequirements> {
    const source = this.sourceFor(paymentRequirements.network);
    if (hasAtumResource(paymentRequirements)) {
      throw new AtumEscrowConfigError({
        code: 'INVALID_CONFIG',
        network: paymentRequirements.network,
        message: `atum-escrow: a route may not set extra.${ATUM_RESOURCE_EXTRA_KEY}; the scheme binds each 402 to the requested page`,
      });
    }

    const atum: AtumEscrowExtra = {
      destination: {
        network: this.config.destination.network,
        asset: this.config.destination.asset,
        address: this.config.destination.address,
      },
      fulfillmentAmount: this.config.fulfillmentAmount,
      escrow: source.escrow,
      fulfillmentProxy: this.config.fulfillmentProxy,
      reserver: this.config.reserver,
      releaser: this.config.releaser,
      fulfillmentVerifierEndpoint: this.config.fulfillmentVerifierEndpoint,
      quoteDeadlineSeconds: this.config.quoteDeadlineSeconds,
      fulfillmentDeadlineSeconds: this.config.fulfillmentDeadlineSeconds,
    };

    // A Solana source carries its escrow signature-domain, which the payer needs to compose the
    // V3 deposit signature. Both values are properties of the deployed escrow, so a rebuild
    // reproduces them byte-for-byte. EVM/Tron sources emit neither.
    //
    // The deposit's issue time is deliberately NOT here. It anchors the escrow's replay window
    // against the Solana cluster clock, which the merchant does not read and cannot speak for,
    // and every field of this block has to be reproducible: the payer echoes the requirement it
    // was quoted, the resource server rebuilds the block on the paid request, and x402 requires
    // the two to agree. A clock reading cannot satisfy that. The payer stamps it at signing time.
    if (
      source.svmSignatureClusterId !== undefined &&
      source.svmSignatureDomainVersion !== undefined
    ) {
      atum.svmSignatureClusterId = source.svmSignatureClusterId;
      atum.svmSignatureDomainVersion = source.svmSignatureDomainVersion;
    }
    // Published only when configured, so a merchant whose facilitator predates the field keeps
    // serving requirements it accepts. Configuration, so a rebuild reproduces it.
    if (source.depositRequestHashVersions !== undefined) {
      atum.depositRequestHashVersions = [...source.depositRequestHashVersions] as [
        number,
        ...number[],
      ];
    }

    return {
      ...paymentRequirements,
      payTo: source.escrow,
      extra: { ...paymentRequirements.extra, atum },
    };
  }

  /**
   * Advertise that this resource needs a purchase identifier.
   *
   * @remarks
   * The identifier travels in the standard `payment-identifier` extension, which lives on the
   * `402` response as a whole rather than on an individual accept — so it is declared here,
   * the only scheme hook x402 gives access to the response being assembled.
   *
   * Declaring the extension is what tells a payer — including one that knows nothing about
   * this scheme — that a payment without an identifier will be refused, and what shape the
   * identifier has to take. `required` is always `true`: the scheme derives the payment's
   * `request_id` from the identifier, and without one a re-attempt of a purchase cannot be
   * recognised as the same purchase, so there is no safe payment to accept.
   *
   * A resource server that already tracks the purchase may name it itself, so an `id` it declared
   * is preserved — the framework treats a declared value as authoritative, a payer may add to it
   * but not overwrite it, and discarding it here would break that. `required` is merged
   * field-by-field rather than left alone with the rest of the declaration, because it is not the
   * resource server's to choose: a declaration of `required: false` would publish a `402`
   * advertising an optional identifier while the client and the facilitator still refuse a payment
   * without one, so the `402` would simply be untrue.
   *
   * The hook also binds each atum-escrow accept to the page being paid for, by adding
   * `extra.atumResource` (see {@link atumEscrowResource}): the payer and the facilitator both fold it
   * into `request_id`, so a payment for one page cannot be replayed against another. Over HTTP it is
   * the routed path and the canonical parsed query of the live request, never the route's
   * configured `resource`; an adapter without `getQueryParams` is refused. Elsewhere it is
   * `resourceInfo.url`. x402 enforces an additive-only mutation policy on `extra` after this hook
   * (`assertAcceptsAdditiveExtraAfterSchemeEnrich`), so `extra.atum` is left exactly as
   * {@link AtumEscrowServerScheme.enhancePaymentRequirements} built it and only the new key is added.
   *
   * @param context - the 402 being assembled
   * @returns the accepts list, with `extra.atumResource` added to the accept this call is for
   * @throws if no resource can be determined for the page
   */
  async enrichPaymentRequiredResponse(
    context: SchemePaymentRequiredContext,
  ): Promise<PaymentRequirements[]> {
    const declarations = (context.paymentRequiredResponse.extensions ??= {});
    const declared = declarations[PAYMENT_IDENTIFIER] as PaymentIdentifierExtension | undefined;
    const ours = declarePaymentIdentifier(true);
    declarations[PAYMENT_IDENTIFIER] = declared
      ? { ...declared, info: { ...declared.info, required: true } }
      : ours;

    // Core calls this once per accept in order, so the first atum-escrow accept still lacking the
    // key is this call's.
    const target = context.requirements.findIndex(
      (r) => r.scheme === ATUM_ESCROW_SCHEME && !hasAtumResource(r),
    );
    if (target === -1) return context.requirements;
    const resource = resourceOf(context);
    return context.requirements.map((r, i) =>
      i === target ? { ...r, extra: { ...r.extra, [ATUM_RESOURCE_EXTRA_KEY]: resource } } : r,
    );
  }
}

export { registerAtumEscrowScheme, type AtumEscrowServerRegistrar } from './register';

// The same object the payer client exports, so a merchant extending the default groups starts
// from exactly what its payers enforce.
export { DEFAULT_PEG_GROUPS } from '../peg';
