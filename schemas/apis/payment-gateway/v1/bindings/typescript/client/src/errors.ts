import { ApiError } from './generated/core/ApiError';
import type { ErrorResponse } from './generated/types.gen';

/**
 * The gateway accepted the request but did not answer inside the client's budget.
 *
 * Not an {@link ApiError}: there is no response, status or error body, so
 * `isApiError` and `getErrorResponse` stay false for it. It carries no verdict on
 * the request either, since a timed-out submit may still have been accepted.
 */
export class GatewayTimeoutError extends Error {
  constructor(
    readonly baseUrl: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Gateway at ${baseUrl || '(same origin)'} did not respond within ${formatSeconds(timeoutMs)}`,
    );
    this.name = 'GatewayTimeoutError';
  }
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

/** Type guard for {@link GatewayTimeoutError}, the unresponsive-gateway case. */
export function isGatewayTimeoutError(err: unknown): err is GatewayTimeoutError {
  return err instanceof GatewayTimeoutError;
}

/**
 * Type guard for the SDK's transport-level error.
 *
 * Every non-2xx gateway response is thrown by the generated client as an
 * {@link ApiError}, which also carries the transport detail (`status`, `url`).
 */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/**
 * Return the typed, public-facing gateway error carried by a caught
 * {@link ApiError}, or `undefined` when the value is not an `ApiError` or its
 * body is not the public {@link ErrorResponse} shape.
 *
 * The gateway serializes errors as an {@link ErrorResponse}
 * (`{ code, message, request_id?, payment_id?, docs_url?, domain? }`), but the
 * generated client widens the parsed body to `unknown`. This helper narrows it
 * back so consumers can branch on `code`, quote `request_id` to support, and read
 * `payment_id` to reconcile the payment a failed settlement was attempted under.
 * It only ever exposes this outward-facing shape — never any internal error
 * taxonomy.
 *
 * @example
 * try {
 *   await client.payments.submitPayment({ requestBody });
 * } catch (err) {
 *   const gwError = getErrorResponse(err);
 *   if (gwError) {
 *     console.error(gwError.code, gwError.message, gwError.request_id);
 *   } else {
 *     throw err;
 *   }
 * }
 */
export function getErrorResponse(err: unknown): ErrorResponse | undefined {
  if (!(err instanceof ApiError)) {
    return undefined;
  }
  const body = err.body as Partial<ErrorResponse> | null | undefined;
  if (
    body &&
    typeof body === 'object' &&
    typeof body.code === 'string' &&
    typeof body.message === 'string'
  ) {
    return body as ErrorResponse;
  }
  return undefined;
}
