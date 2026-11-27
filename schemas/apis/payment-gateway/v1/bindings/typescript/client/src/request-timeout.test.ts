import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SYNC_WAIT_TIMEOUT_MS,
  applyRequestTimeout,
  dropPartialResponseOnTimeout,
  isAxiosTimeout,
  isSyncWaitRequest,
  ordinaryTimeout,
  timeoutForRequest,
  translateTimeout,
} from './request-timeout';
import { GatewayTimeoutError } from './errors';

const BASE = 'https://gw.example';

describe('the published default budgets', () => {
  it('are pinned', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_SYNC_WAIT_TIMEOUT_MS).toBe(120_000);
  });

  // The gateway holds a long poll for up to payment_sync_wait_seconds (30s), and
  // arms its timer after the client arms its own, so an equal budget loses.
  it('leave the long poll real margin over the gateway cap', () => {
    expect(DEFAULT_SYNC_WAIT_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * 30_000);
  });
});

describe('isSyncWaitRequest', () => {
  // POST /v1/payments takes no wait parameter and holds unconditionally, so the
  // query alone does not identify a long poll.
  it.each([
    ['POST', 'https://gw/v1/payments', true],
    ['POST', 'https://gw/v1/payments/awards', true],
    ['POST', 'https://gw/v1/payments/quote-requests?wait=true', true],
    ['POST', 'https://gw/v1/payments/quote-requests?wait=false', false],
    ['POST', 'https://gw/v1/payments/quote-requests', false],
    ['GET', 'https://gw/v1/payments/0xabc', false],
    ['GET', 'https://gw/v1/payments', false],
    ['POST', 'https://gw/v1/authorizations', false],
  ])('%s %s -> %s', (method, url, expected) => {
    expect(isSyncWaitRequest({ method, url })).toBe(expected);
  });

  it('reads a wait flag passed beside the path', () => {
    expect(
      isSyncWaitRequest({ method: 'POST', url: '/v1/payments/quote-requests', wait: true }),
    ).toBe(true);
    expect(
      isSyncWaitRequest({ method: 'POST', url: '/v1/payments/quote-requests', wait: false }),
    ).toBe(false);
  });

  it('matches a gateway path under a BASE that carries its own prefix', () => {
    expect(isSyncWaitRequest({ method: 'POST', url: 'https://gw/api/v1/payments' })).toBe(true);
  });

  it('accepts a lowercase method', () => {
    expect(isSyncWaitRequest({ method: 'post', url: 'https://gw/v1/payments' })).toBe(true);
  });

  it('reads the query, not the path', () => {
    expect(isSyncWaitRequest({ method: 'GET', url: 'https://gw/v1/wait=true/x' })).toBe(false);
  });

  it('handles a missing method and url', () => {
    expect(isSyncWaitRequest({})).toBe(false);
  });
});

describe('timeoutForRequest', () => {
  it('gives a promptly-answered request the ordinary budget', () => {
    expect(timeoutForRequest({ method: 'GET', url: 'https://gw/v1/payments/0xabc' })).toBe(
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    expect(ordinaryTimeout()).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it('gives a held-open request the longer budget', () => {
    expect(timeoutForRequest({ method: 'POST', url: 'https://gw/v1/payments' })).toBe(
      DEFAULT_SYNC_WAIT_TIMEOUT_MS,
    );
  });

  it('honours overrides', () => {
    const timeouts = { timeoutMs: 1_000, syncWaitTimeoutMs: 2_000 };

    expect(timeoutForRequest({ method: 'GET', url: 'https://gw/v1/health' }, timeouts)).toBe(1_000);
    expect(timeoutForRequest({ method: 'POST', url: 'https://gw/v1/payments' }, timeouts)).toBe(
      2_000,
    );
    expect(ordinaryTimeout(timeouts)).toBe(1_000);
  });
});

describe('applyRequestTimeout', () => {
  it('sets the budget for the request', () => {
    expect(applyRequestTimeout()({ method: 'GET', url: 'https://gw/v1/health' }).timeout).toBe(
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    expect(applyRequestTimeout()({ method: 'POST', url: 'https://gw/v1/payments' }).timeout).toBe(
      DEFAULT_SYNC_WAIT_TIMEOUT_MS,
    );
  });

  it('leaves a timeout the caller already set', () => {
    expect(applyRequestTimeout()({ url: 'https://gw/v1/health', timeout: 5 }).timeout).toBe(5);
    expect(applyRequestTimeout()({ url: 'https://gw/v1/health', timeout: 0 }).timeout).toBe(0);
  });

  it('does not mutate the config it is given', () => {
    const config = { url: 'https://gw/v1/health' };

    applyRequestTimeout()(config);

    expect(config).not.toHaveProperty('timeout');
  });
});

describe('translateTimeout', () => {
  it.each(['ECONNABORTED', 'ETIMEDOUT'])('restates a %s axios error', (code) => {
    const error = translateTimeout({ code, config: { timeout: 30_000 } }, BASE, 1);

    expect(error).toBeInstanceOf(GatewayTimeoutError);
    expect((error as Error).message).toBe(
      'Gateway at https://gw.example did not respond within 30s',
    );
  });

  // Once headers arrive, axios reports a mid-body abort at a later stage.
  it('restates an abort that fires after the headers', () => {
    const error = translateTimeout(
      { code: 'ERR_BAD_RESPONSE', message: 'stream has been aborted', config: { timeout: 30_000 } },
      BASE,
      1,
    );

    expect(error).toBeInstanceOf(GatewayTimeoutError);
  });

  it('leaves an unrelated ERR_BAD_RESPONSE alone', () => {
    const malformed = { code: 'ERR_BAD_RESPONSE', message: 'Unexpected token < in JSON' };

    expect(translateTimeout(malformed, BASE, 1)).toBe(malformed);
  });

  // Axios 1.20 attaches the headers it already received. That must not stop
  // the abort from counting as a timeout.
  it('still recognises a mid-body abort that carries a partial response', () => {
    const error = {
      code: 'ERR_BAD_RESPONSE',
      message: 'stream has been aborted',
      response: { status: 400, statusText: 'Bad Request', data: '{"code":"INVALID_REQUEST"' },
    };

    expect(isAxiosTimeout(error)).toBe(true);
    dropPartialResponseOnTimeout(error);
    expect(error).not.toHaveProperty('response');
    expect(translateTimeout(error, BASE, 1)).toBeInstanceOf(GatewayTimeoutError);
  });

  it('does not strip a completed HTTP error', () => {
    const error = {
      code: 'ERR_BAD_REQUEST',
      message: 'Request failed with status code 400',
      response: { status: 400, statusText: 'Bad Request' },
    };

    expect(dropPartialResponseOnTimeout(error)).toBe(error);
    expect(error).toHaveProperty('response');
  });

  it('falls back to the computed budget when the error carries none', () => {
    const error = translateTimeout({ code: 'ECONNABORTED' }, BASE, 1_500);

    expect((error as Error).message).toBe(
      'Gateway at https://gw.example did not respond within 1.5s',
    );
  });

  // An explicit cancellation is not an unresponsive gateway.
  it('leaves a cancellation alone', () => {
    const cancelled = { code: 'ERR_CANCELED' };

    expect(translateTimeout(cancelled, BASE, 1)).toBe(cancelled);
  });

  it('leaves an unrelated error alone', () => {
    const refused = { code: 'ECONNREFUSED' };

    expect(translateTimeout(refused, BASE, 1)).toBe(refused);
    expect(isAxiosTimeout(refused)).toBe(false);
    expect(isAxiosTimeout(null)).toBe(false);
  });

  it('names a same-origin base readably', () => {
    expect(new GatewayTimeoutError('', 30_000).message).toBe(
      'Gateway at (same origin) did not respond within 30s',
    );
  });
});
