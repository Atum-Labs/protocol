import type { AxiosRequestConfig } from 'axios';
import { GatewayTimeoutError } from './errors';

/**
 * Budget for a request the gateway answers as soon as it can. Generous on
 * purpose: aborting a live submit loses track of a payment, while waiting only
 * costs patience. Bounds socket inactivity, not total time, so a large healthy
 * response is never cut off partway.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Budget for a request the gateway holds open while it collects quotes or
 * settles. Must clear the server's own cap (`payment_sync_wait_seconds` 30s,
 * `quote_sync_wait_seconds` 5s, both deployment-configurable) with margin: the
 * client's timer starts at connect, before the server arms its own, so an equal
 * budget loses the race every time.
 */
export const DEFAULT_SYNC_WAIT_TIMEOUT_MS = 120_000;

/**
 * Paths held open regardless of any query flag. `POST /v1/payments` takes no
 * `wait` parameter and holds unconditionally while settlement runs, so the query
 * alone does not identify a long poll.
 */
const SYNC_HOLD_PATHS = ['/v1/payments', '/v1/payments/awards'];

/** Per-client overrides for the two budgets above. */
export type RequestTimeouts = {
  /** Requests answered as soon as possible. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Requests the gateway holds open. Defaults to {@link DEFAULT_SYNC_WAIT_TIMEOUT_MS}. */
  syncWaitTimeoutMs?: number;
};

/**
 * Enough of a request to classify it. The two call sites differ: the axios
 * interceptor has the query appended to the URL, the generated transport keeps
 * it in a separate object.
 */
export type RequestShape = {
  method?: string;
  /** Full URL or path template; the query may or may not be present. */
  url?: string;
  /** The `wait` query value, for callers whose URL does not carry it. */
  wait?: unknown;
};

/** The path portion of a full URL or a bare path. */
function pathOf(url: string | undefined): string {
  if (!url) return '';
  const path = url.split('?')[0];
  const scheme = path.indexOf('://');
  if (scheme === -1) return path;
  const host = path.indexOf('/', scheme + 3);
  return host === -1 ? '' : path.slice(host);
}

function hasWaitTrueQuery(url: string | undefined): boolean {
  const query = url?.indexOf('?') ?? -1;
  if (query === -1) return false;
  return new URLSearchParams(url!.slice(query + 1)).get('wait') === 'true';
}

/** Whether the gateway may hold this request open rather than answering promptly. */
export function isSyncWaitRequest({ method, url, wait }: RequestShape): boolean {
  if (wait === true || wait === 'true' || hasWaitTrueQuery(url)) return true;
  if (method?.toUpperCase() !== 'POST') return false;
  // A BASE carrying its own path prefix leaves the gateway path as a suffix.
  const path = pathOf(url);
  return SYNC_HOLD_PATHS.some((held) => path === held || path.endsWith(held));
}

/** The budget for a request the gateway answers as soon as it can. */
export function ordinaryTimeout(timeouts: RequestTimeouts = {}): number {
  return timeouts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
}

/** The budget that applies to a request. */
export function timeoutForRequest(request: RequestShape, timeouts: RequestTimeouts = {}): number {
  return isSyncWaitRequest(request)
    ? (timeouts.syncWaitTimeoutMs ?? DEFAULT_SYNC_WAIT_TIMEOUT_MS)
    : ordinaryTimeout(timeouts);
}

/**
 * Request interceptor that applies the budget. A timeout already on the config
 * wins, so a caller's own interceptor stays in control.
 */
export function applyRequestTimeout(
  timeouts: RequestTimeouts = {},
): (config: AxiosRequestConfig) => AxiosRequestConfig {
  return (config) => ({
    ...config,
    timeout:
      config.timeout ?? timeoutForRequest({ method: config.method, url: config.url }, timeouts),
  });
}

/**
 * Axios reports a timeout as `ECONNABORTED`, or `ETIMEDOUT` under its
 * `clarifyTimeoutError` option. Once headers have arrived it instead surfaces as
 * `ERR_BAD_RESPONSE` with an aborted stream. An explicit cancellation is
 * `ERR_CANCELED` and is left alone.
 */
export function isAxiosTimeout(error: unknown): boolean {
  const failure = error as { code?: string; message?: string } | null | undefined;
  if (!failure) return false;
  if (failure.code === 'ECONNABORTED' || failure.code === 'ETIMEDOUT') return true;
  return (
    failure.code === 'ERR_BAD_RESPONSE' && /stream has been aborted/i.test(failure.message ?? '')
  );
}

/**
 * Axios 1.20 attaches a partial `response` when the timeout fires after headers
 * have arrived. The generated `sendRequest` treats any error that carries a
 * `response` as a completed HTTP status and the timeout never reaches
 * {@link translateTimeout}. Drop the partial body so a stalled stream still
 * surfaces as a timeout.
 */
export function dropPartialResponseOnTimeout(error: unknown): unknown {
  if (isAxiosTimeout(error) && error !== null && typeof error === 'object' && 'response' in error) {
    delete (error as { response?: unknown }).response;
  }
  return error;
}

/**
 * Restate an axios timeout as a {@link GatewayTimeoutError}. Anything else is
 * returned untouched, so only the silent-hang case gets the friendlier message.
 */
export function translateTimeout(
  error: unknown,
  baseUrl: string,
  fallbackTimeoutMs: number,
): unknown {
  if (!isAxiosTimeout(error)) return error;
  const configured = (error as { config?: { timeout?: number } }).config?.timeout;
  return new GatewayTimeoutError(baseUrl, configured ?? fallbackTimeoutMs);
}
