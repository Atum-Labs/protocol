/**
 * Test-only helpers for driving {@link AtumEscrowServerScheme} the way `x402ResourceServer`
 * does.
 *
 * A complete 402 takes TWO hooks: `enhancePaymentRequirements` builds each accept (`payTo` and
 * the `extra.atum` block), then `enrichPaymentRequiredResponse` declares the
 * `payment-identifier` extension on the response as a whole. A test that runs only the first
 * gets accepts a payer can read but no declaration telling it to name the purchase; one that
 * runs only the second gets a declaration and no corridor data. The second hook also binds the
 * accept to its page (`extra.atumResource`), `GET /paid` unless another URL is given. These helpers run both, in
 * x402's order, so tests exercise the same shape a real payer receives.
 *
 * Also the shared ways to capture a thrown or rejected error, and to assert one is the
 * config error a merchant would catch.
 *
 * NOT exported from the package (`package.json#exports` lists only client/server/facilitator/
 * fetch) — internal test surface, excluded from the published `dist`.
 */

import { expect } from 'vitest';
import type { PaymentRequirements } from '@x402/core/types';
import {
  AtumEscrowConfigError,
  type AtumEscrowConfigErrorCode,
  type AtumEscrowServerScheme,
} from './index';

/**
 * Build a complete requirement by running both server hooks in x402's order.
 *
 * @param scheme - the server scheme under test
 * @param base - the base requirement (as `parsePrice` would have shaped it)
 * @param url - the URL of the HTTP request the 402 answers
 * @returns the enriched requirement and the extensions the scheme declared on the 402
 */
export async function buildRequirement(
  scheme: AtumEscrowServerScheme,
  base: PaymentRequirements,
  url = 'https://example.test/paid',
): Promise<{ requirement: PaymentRequirements; extensions: Record<string, unknown> }> {
  const enhanced = await scheme.enhancePaymentRequirements(base);
  // Mirror the live shape: core hands the hook the live accepts array and the 402 it is
  // assembling, and reads back both the returned accepts and whatever the scheme declared.
  const paymentRequiredResponse = {
    x402Version: 2,
    resource: { url: 'https://example.test/paid' },
    accepts: [enhanced],
  } as unknown as Parameters<
    NonNullable<AtumEscrowServerScheme['enrichPaymentRequiredResponse']>
  >[0]['paymentRequiredResponse'];

  const accepts = await scheme.enrichPaymentRequiredResponse({
    requirements: [enhanced],
    resourceInfo: { url: 'https://example.test/paid' },
    paymentRequiredResponse,
    // An HTTP GET for `url`, so the accept is bound to its page as a live 402 would be.
    transportContext: httpRequest(url),
  } as Parameters<NonNullable<AtumEscrowServerScheme['enrichPaymentRequiredResponse']>>[0]);

  return {
    requirement: accepts[0]!,
    extensions: (paymentRequiredResponse.extensions ?? {}) as Record<string, unknown>,
  };
}

/** The request fields an Express handler exposes, as `@x402/express` reads them. */
export interface ExpressLikeRequest {
  method?: string;
  protocol?: string;
  host?: string;
  /** The full request target, including any mount prefix and the query string. */
  originalUrl: string;
  /** The mount-relative path Express reports as `req.path`. */
  path: string;
  /** The parsed query Express reports as `req.query`. */
  query: unknown;
}

/**
 * The transport context core builds from an `@x402/express` adapter: `getUrl()` joins
 * `req.protocol`, the Host header and `req.originalUrl`, `getPath()` is `req.path` and
 * `getQueryParams()` is `req.query`.
 */
export function expressTransport(req: ExpressLikeRequest) {
  const host = req.host ?? 'example.test';
  const adapter = {
    getHeader: (name: string) => (name.toLowerCase() === 'host' ? host : undefined),
    getMethod: () => req.method ?? 'GET',
    getPath: () => req.path,
    getUrl: () => `${req.protocol ?? 'http'}://${host}${req.originalUrl}`,
    getQueryParams: () => req.query,
  };
  return { request: { adapter, path: adapter.getPath(), method: adapter.getMethod() } };
}

/** An unmounted HTTP request for `url`, with each query value parsed as a single string. */
export function httpRequest(url: string, method = 'GET') {
  const parsed = new URL(url);
  return expressTransport({
    method,
    protocol: parsed.protocol.slice(0, -1),
    host: parsed.host,
    originalUrl: `${parsed.pathname}${parsed.search}`,
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams),
  });
}

/** Awaits `pending` and returns what it rejected with, or `undefined` if it resolved. */
export async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (err) {
    return err;
  }
  return undefined;
}

/** Runs `build` and returns what it threw, or `undefined` if it returned normally. */
export function thrownBy(build: () => unknown): unknown {
  try {
    build();
  } catch (err) {
    return err;
  }
  return undefined;
}

/**
 * Asserts `err` is an {@link AtumEscrowConfigError} carrying `code` and, when given, naming
 * `network`. Returns the narrowed error so a caller can go on to assert its message.
 *
 * @param err - what the code under test threw or rejected with
 * @param code - the config error code it must carry
 * @param network - the network it must name; omit to leave `network` unchecked
 * @returns `err`, narrowed
 */
export function expectConfigError(
  err: unknown,
  code: AtumEscrowConfigErrorCode,
  network?: string,
): AtumEscrowConfigError {
  expect(err).toBeInstanceOf(AtumEscrowConfigError);
  expect(err).toBeInstanceOf(Error);
  const configError = err as AtumEscrowConfigError;
  expect(configError.name).toBe('AtumEscrowConfigError');
  expect(configError.code).toBe(code);
  if (network !== undefined) expect(configError.network).toBe(network);
  return configError;
}
