import { isTokenDecimals } from '../source-cap';
import { ATUM_DEFAULT_TRUST_GATEWAYS as generatedTrustGateways } from '../hosts.generated';

/**
 * The payer's trust source for atum-escrow corridors.
 *
 * A 402 names the escrow, the fulfillment proxy, the reserver and the releaser the payer is about
 * to sign into its deposit authorization. The merchant writes those values, but the reserver
 * decides who is paid and how much of the cap, and the releaser decides when the escrow opens, so
 * they are the payer's trust points to choose. The client therefore checks each one against a
 * source the payer controls before signing anything; the 402 is a claim, not an authority.
 */

/**
 * A token a trust source vouches for on one chain. `decimals` is what lets the client compare a
 * source-token cap with a destination-token price.
 *
 * @public
 */
export interface TrustedToken {
  symbol: string;
  address: string;
  decimals: number;
}

/**
 * The addresses a trust source vouches for on one chain.
 *
 * The keys match the corridor defaults the signing library takes, so a trusted set can be compared
 * field by field with what a requirement asks the payer to sign.
 *
 * @public
 */
export interface TrustedRoles {
  /** The source escrow contract: the Permit2 spender a deposit authorizes. */
  escrowContract: string;
  /** The account that signs reserve witnesses (the requirement's `reserver`). */
  quoteSelector: string;
  /** The account that signs release and refund witnesses (the requirement's `releaser`). */
  fulfillmentVerifierAccount: string;
  /** The fulfillment proxy, compared on the chain the payment is delivered on. */
  fulfillmentProxy: string;
  /** The tokens payable on this chain; a payment in any other token is refused. */
  tokens: ReadonlyArray<TrustedToken>;
}

/**
 * Answers which addresses the payer trusts on a chain, given its CAIP-2 id.
 *
 * Rejects with {@link AtumEscrowTrustError} `CHAIN_NOT_TRUSTED` when it vouches for nothing on the
 * chain, and `TRUST_SOURCE_UNAVAILABLE` when it cannot find out. Any other rejection is reported by
 * the client as `TRUST_SOURCE_UNAVAILABLE`.
 *
 * @public
 */
export type TrustResolver = (network: string) => Promise<TrustedRoles>;

/**
 * Why a payment was refused before signing.
 *
 * @public
 */
export type AtumEscrowTrustErrorCode =
  | 'UNTRUSTED_ESCROW'
  | 'UNTRUSTED_PAY_TO'
  | 'UNTRUSTED_RESERVER'
  | 'UNTRUSTED_RELEASER'
  | 'UNTRUSTED_FULFILLMENT_PROXY'
  | 'UNTRUSTED_ASSET'
  | 'ASSETS_NOT_COMPARABLE'
  | 'MARKUP_EXCEEDED'
  | 'CHAIN_NOT_TRUSTED'
  | 'TRUST_SOURCE_UNAVAILABLE';

/**
 * A payment the client refused to sign because its corridor is not one the payer trusts.
 *
 * `code` is the stable thing to branch on. For the `UNTRUSTED_*` codes, `field` names the
 * requirement member that failed, `expected` is the trusted value and `actual` the value the 402
 * asked for, both as written.
 *
 * @public
 */
export class AtumEscrowTrustError extends Error {
  readonly code: AtumEscrowTrustErrorCode;
  readonly network: string;
  readonly field?: string;
  readonly expected?: string;
  readonly actual?: string;

  constructor(init: {
    code: AtumEscrowTrustErrorCode;
    network: string;
    message: string;
    field?: string;
    expected?: string;
    actual?: string;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'AtumEscrowTrustError';
    this.code = init.code;
    this.network = init.network;
    this.field = init.field;
    this.expected = init.expected;
    this.actual = init.actual;
  }
}

/**
 * The payment gateways the client asks when the payer supplies no trust source: Atum's production
 * mainnet and production testnet deployments. Their chain ids never overlap, so at most one serves
 * a given chain.
 *
 * @public
 */
export const ATUM_DEFAULT_TRUST_GATEWAYS: readonly string[] = generatedTrustGateways;

/**
 * Options for {@link atumGatewayTrust}.
 *
 * @public
 */
export interface AtumGatewayTrustOptions {
  /**
   * Gateway base URLs to ask. Defaults to {@link ATUM_DEFAULT_TRUST_GATEWAYS}.
   *
   * Each chain must be served by at most one gateway in the list: the first trusted answer is
   * used, so two gateways vouching for different roles on one chain would make the outcome depend
   * on which answers first.
   */
  gateways?: readonly string[];
  /** The `fetch` to use. Defaults to the global one, read at call time. */
  fetch?: typeof fetch;
  /** Clock for cache expiry, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** How long a trusted answer is reused, in milliseconds. Defaults to 300000. */
  ttlMs?: number;
  /** How long one gateway may take to answer, in milliseconds. Defaults to 5000. */
  timeoutMs?: number;
}

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 5_000;

type GatewayAnswer =
  | { kind: 'trusted'; roles: TrustedRoles }
  | { kind: 'not-served' }
  | { kind: 'failed'; reason: string };

/**
 * A trust source backed by payment gateways' `GET /v1/defaults`.
 *
 * Every gateway is asked. The first well-formed answer for the chain is trusted. Only when every
 * gateway answers 404 is the chain reported as not trusted: a gateway that failed might have been
 * the one serving it, so any failure without a usable answer is reported as unavailable instead.
 * Trusted answers are cached per chain, and concurrent lookups for a chain share one round of
 * requests; failures are never cached, so recovery needs no wait.
 *
 * @public
 */
export function atumGatewayTrust(options: AtumGatewayTrustOptions = {}): TrustResolver {
  const gateways = (options.gateways ?? ATUM_DEFAULT_TRUST_GATEWAYS).map((g) =>
    g.replace(/\/+$/, ''),
  );
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Read at call time so a fetch installed after construction (a polyfill, a test stub) is used.
  const doFetch = (input: string, init: RequestInit): Promise<Response> =>
    (options.fetch ?? globalThis.fetch)(input, init);

  const cache = new Map<string, { roles: TrustedRoles; expiresAt: number }>();
  const inFlight = new Map<string, Promise<TrustedRoles>>();

  async function ask(
    gateway: string,
    network: string,
    lookupDecided: AbortSignal,
  ): Promise<GatewayAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Once the lookup is decided this answer can no longer change it, so the request is dropped
    // rather than left holding a socket and a timer that would keep a short-lived process alive.
    const cancel = (): void => controller.abort();
    lookupDecided.addEventListener('abort', cancel, { once: true });
    try {
      const response = await doFetch(
        `${gateway}/v1/defaults?chain_id=${encodeURIComponent(network)}`,
        { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal },
      );
      if (response.status === 404) return { kind: 'not-served' };
      if (!response.ok)
        return { kind: 'failed', reason: `${gateway} answered HTTP ${response.status}` };
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { kind: 'failed', reason: `${gateway} answered a body that is not JSON` };
      }
      const roles = readRoles(body, network);
      return roles
        ? { kind: 'trusted', roles }
        : {
            kind: 'failed',
            reason: `${gateway} answered defaults that do not describe ${network}`,
          };
    } catch (err) {
      return {
        kind: 'failed',
        reason: controller.signal.aborted
          ? `${gateway} did not answer within ${timeoutMs}ms`
          : `${gateway} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
      lookupDecided.removeEventListener('abort', cancel);
    }
  }

  // Settles on the first trusted answer rather than waiting for every gateway, so one slow
  // gateway does not delay a chain another one serves.
  function lookup(network: string): Promise<TrustedRoles> {
    return new Promise<TrustedRoles>((resolve, reject) => {
      const answers: GatewayAnswer[] = [];
      const decided = new AbortController();
      let settled = false;
      for (const gateway of gateways) {
        void ask(gateway, network, decided.signal).then((answer) => {
          if (settled) return;
          answers.push(answer);
          if (answer.kind === 'trusted') {
            settled = true;
            decided.abort();
            resolve(answer.roles);
            return;
          }
          if (answers.length < gateways.length) return;
          settled = true;
          const failures = answers.filter(
            (a): a is Extract<GatewayAnswer, { kind: 'failed' }> => a.kind === 'failed',
          );
          reject(
            failures.length === 0
              ? new AtumEscrowTrustError({
                  code: 'CHAIN_NOT_TRUSTED',
                  network,
                  message: `atum-escrow: no trusted gateway serves ${network}`,
                })
              : new AtumEscrowTrustError({
                  code: 'TRUST_SOURCE_UNAVAILABLE',
                  network,
                  message: `atum-escrow: could not determine the trusted roles for ${network}: ${failures.map((f) => f.reason).join('; ')}`,
                }),
          );
        });
      }
      if (gateways.length === 0) {
        reject(
          new AtumEscrowTrustError({
            code: 'CHAIN_NOT_TRUSTED',
            network,
            message: `atum-escrow: no trusted gateway is configured, so nothing is trusted on ${network}`,
          }),
        );
      }
    });
  }

  return async (network: string): Promise<TrustedRoles> => {
    const hit = cache.get(network);
    if (hit && now() < hit.expiresAt) return hit.roles;
    const pending = inFlight.get(network);
    if (pending) return pending;
    const promise = lookup(network)
      .then((roles) => {
        cache.set(network, { roles, expiresAt: now() + ttlMs });
        return roles;
      })
      .finally(() => inFlight.delete(network));
    inFlight.set(network, promise);
    return promise;
  };
}

function readRoles(body: unknown, network: string): TrustedRoles | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const verifier = b['fulfillment_verifier'];
  const account =
    typeof verifier === 'object' && verifier !== null
      ? (verifier as Record<string, unknown>)['account']
      : undefined;
  const fields = [
    b['chain_id'],
    b['escrow_contract'],
    b['quote_selector'],
    b['fulfillment_proxy'],
    account,
  ];
  if (!fields.every((f): f is string => typeof f === 'string' && f !== '')) return undefined;
  if (b['chain_id'] !== network) return undefined;
  // A chain with no allowlisted tokens answers without the field; that is an empty list, not a
  // malformed answer.
  const tokens = b['tokens'] === undefined ? [] : readTokens(b['tokens']);
  if (!tokens) return undefined;
  return {
    escrowContract: b['escrow_contract'] as string,
    quoteSelector: b['quote_selector'] as string,
    fulfillmentVerifierAccount: account as string,
    fulfillmentProxy: b['fulfillment_proxy'] as string,
    tokens,
  };
}

function readTokens(value: unknown): TrustedToken[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tokens: TrustedToken[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const t = entry as Record<string, unknown>;
    const { symbol, address, decimals } = t;
    if (typeof symbol !== 'string' || symbol === '') return undefined;
    if (typeof address !== 'string' || address === '') return undefined;
    if (!isTokenDecimals(decimals)) return undefined;
    tokens.push({ symbol, address, decimals });
  }
  return tokens;
}
