import { describe, it, expect } from 'vitest';
import { ApiError, GatewayTimeoutError } from '@atum-labs/payment-gateway-client';
import { Errors } from 'mppx';
import catalog from '../../../../../../error/v1/catalog.json';
import {
  PaymentRejectedError,
  PaymentRetryableError,
  SettlementPendingError,
  SettlementFailedError,
  gatewayRefusalOf,
  isPaymentRejected,
  isPaymentRetryable,
  isSettlementPending,
} from './errors.js';

type CatalogCode = keyof typeof catalog.entries;

/**
 * What the gateway's client throws for an error answer carrying `code`, with the status and body
 * the error catalog gives it: the public code and message, plus the retry guidance.
 */
function gatewayAnswer(code: CatalogCode): ApiError {
  const entry: {
    public_code: string;
    public_message: string;
    http_status: number;
    retry_classification?: string;
    request_id_reusable?: boolean;
  } = catalog.entries[code];
  const body = {
    code: entry.public_code,
    message: entry.public_message,
    request_id: 'req_1',
    domain: 'PAYMENT_GATEWAY',
    ...(entry.retry_classification !== undefined
      ? { retry_classification: entry.retry_classification }
      : {}),
    ...(entry.request_id_reusable !== undefined
      ? { request_id_reusable: entry.request_id_reusable }
      : {}),
  };
  return apiError(entry.http_status, body);
}

function apiError(status: number, body: unknown): ApiError {
  return new ApiError(
    { method: 'POST', url: '/v1/payments' },
    { url: 'https://gateway.example/v1/payments', ok: false, status, statusText: '', body },
    'gateway error',
  );
}

/** The body of a retryable gateway answer, reused where only the body matters. */
const RETRYABLE_BODY = gatewayAnswer('AUTHORIZATION_UNAVAILABLE').body;

describe('SettlementPendingError.toProblemDetails', () => {
  it('adds paymentId as its own field, not just interpolated into detail', () => {
    const problem = new SettlementPendingError({ paymentId: 'pay_123' }).toProblemDetails();
    expect(problem.paymentId).toBe('pay_123');
    // The base fields still come through — this is additive, not a replacement.
    expect(problem.type).toBe('https://paymentauth.org/problems/payment-action-required');
    expect(problem.status).toBe(402);
    expect(problem.detail).toContain('pay_123');
  });

  it('omits paymentId rather than sending it as undefined when none was issued', () => {
    const problem = new SettlementPendingError({}).toProblemDetails();
    expect('paymentId' in problem).toBe(false);
  });

  it('still forwards challengeId, since the override must not drop the base parameter', () => {
    const problem = new SettlementPendingError({ paymentId: 'pay_123' }).toProblemDetails('chal_1');
    expect(problem.challengeId).toBe('chal_1');
  });
});

describe('SettlementFailedError.toProblemDetails', () => {
  it('adds paymentId and state as their own fields', () => {
    const problem = new SettlementFailedError({
      paymentId: 'pay_456',
      state: 'failed',
    }).toProblemDetails();
    expect(problem.paymentId).toBe('pay_456');
    expect(problem.state).toBe('failed');
    expect(problem.type).toBe('https://paymentauth.org/problems/verification-failed');
  });

  it('omits paymentId when none was issued, but always reports state', () => {
    const problem = new SettlementFailedError({ state: 'failed' }).toProblemDetails();
    expect('paymentId' in problem).toBe(false);
    expect(problem.state).toBe('failed');
  });
});

describe('PaymentRetryableError', () => {
  const err = new PaymentRetryableError({
    code: 'AUTHORIZATION_UNAVAILABLE',
    detail: 'This payment could not be authorized because a check could not be completed.',
  });

  it('answers the payer with a 402 asking for a re-attempt, not a 400 asking to fix the request', () => {
    // mppx answers with whatever PaymentError leaves verify(), and replaces anything else with a
    // generic verification failure, so the class decides what the payer is told.
    expect(err).toBeInstanceOf(Errors.PaymentError);
    const problem = err.toProblemDetails();
    expect(problem.status).toBe(402);
    expect(problem.type).toBe('https://paymentauth.org/problems/payment-action-required');
    expect(problem.detail).toContain('(AUTHORIZATION_UNAVAILABLE)');
    expect(problem.detail).toMatch(/nothing was charged/);
    expect(problem.detail).toMatch(/keeping the SAME intent id/);
  });

  it('adds code as its own field, so a payer can tell it from a payment still settling', () => {
    const problem = err.toProblemDetails();
    expect(problem.code).toBe('AUTHORIZATION_UNAVAILABLE');
    // Same problem type as a pending payment; `code` is the difference on the wire.
    expect(new SettlementPendingError({}).toProblemDetails().type).toBe(problem.type);
    expect('code' in new SettlementPendingError({}).toProblemDetails()).toBe(false);
  });

  it('still forwards challengeId, since the override must not drop the base parameter', () => {
    expect(err.toProblemDetails('chal_1').challengeId).toBe('chal_1');
  });

  it('keeps the gateway code on the error', () => {
    expect(err.code).toBe('AUTHORIZATION_UNAVAILABLE');
  });

  it('is told apart from the other outcomes by its guard alone', () => {
    expect(isPaymentRetryable(err)).toBe(true);
    expect(isPaymentRejected(err)).toBe(false);
    expect(isSettlementPending(err)).toBe(false);
    expect(isPaymentRetryable(new PaymentRejectedError({ code: 'X', detail: 'x' }))).toBe(false);
    expect(isPaymentRetryable(new SettlementPendingError({}))).toBe(false);
    expect(isPaymentRetryable(new Error('busy'))).toBe(false);
  });
});

describe('gatewayRefusalOf', () => {
  it('reads 503 AUTHORIZATION_UNAVAILABLE as retryable, with the gateway code and message', () => {
    const refusal = gatewayRefusalOf(gatewayAnswer('AUTHORIZATION_UNAVAILABLE'));

    expect(isPaymentRetryable(refusal)).toBe(true);
    expect(isPaymentRejected(refusal)).toBe(false);
    expect(refusal?.code).toBe('AUTHORIZATION_UNAVAILABLE');
    expect(refusal?.message).toContain(catalog.entries.AUTHORIZATION_UNAVAILABLE.public_message);
  });

  it.each(['AUTH_SERVICE_UNAVAILABLE', 'SERVICE_PAUSED'] as const)(
    'reads %s, also classified retry-after-delay with the identifier unused, as retryable',
    (code) => {
      expect(isPaymentRetryable(gatewayRefusalOf(gatewayAnswer(code)))).toBe(true);
    },
  );

  it('keeps a 429 a rejection, though classified retry-after-delay, so fetch does not re-attempt at once', () => {
    // The classification alone would make it retryable; the status is what keeps it out.
    const answer = gatewayAnswer('RATE_LIMIT_EXCEEDED');
    expect(answer.status).toBe(429);
    expect(answer.body).toMatchObject({
      retry_classification: 'RETRY_AFTER_DELAY',
      request_id_reusable: true,
    });

    const refusal = gatewayRefusalOf(answer);
    expect(isPaymentRejected(refusal)).toBe(true);
    expect(isPaymentRetryable(refusal)).toBe(false);
    expect(refusal?.code).toBe('RATE_LIMIT_EXCEEDED');

    // Any 429, not just that code.
    expect(isPaymentRejected(gatewayRefusalOf({ status: 429, body: RETRYABLE_BODY }))).toBe(true);
  });

  it.each(['AMOUNT_LIMIT_EXCEEDED', 'VOLUME_LIMIT_EXCEEDED'] as const)(
    'keeps %s a rejection with its own code, so fetch does not re-attempt a purchase the limit refuses again',
    (code) => {
      // VOLUME_LIMIT_EXCEEDED is classified retry-after-delay, but its wait runs to 00:00 UTC. A
      // retryable answer would tell the payer to re-attempt "in a moment", and a payment-enabled
      // fetch would do so at once.
      const answer = gatewayAnswer(code);
      expect(answer.status).toBe(403);

      const refusal = gatewayRefusalOf(answer);
      expect(isPaymentRejected(refusal)).toBe(true);
      expect(isPaymentRetryable(refusal)).toBe(false);
      expect(refusal?.code).toBe(code);
      expect(refusal?.message).toContain(catalog.entries[code].public_message);
    },
  );

  it('leaves a 503 whose identifier is spent as an unknown outcome, so status alone is not enough', () => {
    // SERVICE_BUSY with RETRY_WITH_NEW_IDENTIFIER: re-attempting the same purchase would only
    // replay this answer.
    const answer = gatewayAnswer('SETTLER_GATEWAY_AT_CAPACITY');
    expect(answer.status).toBe(503);
    expect(gatewayRefusalOf(answer)).toBeUndefined();
  });

  it('leaves a retry-after-delay answer that does not say the identifier is unused as an unknown outcome', () => {
    // An absent request_id_reusable means undetermined.
    const answer = gatewayAnswer('FULFILLMENT_VERIFIER_UNAVAILABLE');
    expect(answer.status).toBe(503);
    expect((answer.body as Record<string, unknown>).retry_classification).toBe('RETRY_AFTER_DELAY');
    expect(gatewayRefusalOf(answer)).toBeUndefined();
  });

  it('reads any other 4xx as a rejection, with the gateway code and message', () => {
    const refusal = gatewayRefusalOf(gatewayAnswer('IDEMPOTENCY_TERMS_MISMATCH'));

    expect(isPaymentRejected(refusal)).toBe(true);
    expect(isPaymentRetryable(refusal)).toBe(false);
    expect(refusal?.code).toBe('IDEMPOTENCY_TERMS_MISMATCH');
    expect(refusal?.message).toContain(catalog.entries.IDEMPOTENCY_TERMS_MISMATCH.public_message);
  });

  it.each(['INTERNAL_ERROR', 'SETTLER_GATEWAY_INTERNAL_ERROR', 'TX_REVERTED'] as const)(
    'leaves %s, a 5xx the gateway does not classify as retryable, as an unknown outcome',
    (code) => {
      const answer = gatewayAnswer(code);
      expect(answer.status).toBeGreaterThanOrEqual(500);
      expect(gatewayRefusalOf(answer)).toBeUndefined();
    },
  );

  it('leaves an answer with no HTTP status as an unknown outcome', () => {
    expect(
      gatewayRefusalOf(new GatewayTimeoutError('https://gateway.example', 1000)),
    ).toBeUndefined();
    expect(gatewayRefusalOf(new Error('socket hang up'))).toBeUndefined();
    expect(gatewayRefusalOf(undefined)).toBeUndefined();
    expect(gatewayRefusalOf('503')).toBeUndefined();
    // A retryable body is not enough without a status to say it is the gateway's answer.
    expect(gatewayRefusalOf({ body: RETRYABLE_BODY })).toBeUndefined();
    expect(gatewayRefusalOf({ status: '503', body: RETRYABLE_BODY })).toBeUndefined();
  });

  it('reads nothing from a status outside 4xx and 5xx, even with a retryable body', () => {
    expect(gatewayRefusalOf({ status: 200, body: RETRYABLE_BODY })).toBeUndefined();
    expect(gatewayRefusalOf({ status: 302, body: RETRYABLE_BODY })).toBeUndefined();
    expect(gatewayRefusalOf({ status: 600, body: RETRYABLE_BODY })).toBeUndefined();
  });

  it("reads a 4xx whose body is not the gateway's error as a rejection, coded by its status", () => {
    // A proxy in front of the gateway answers a denied 403 or 429 with an HTML page.
    const forbidden = gatewayRefusalOf(apiError(403, '<html>Forbidden</html>'));
    expect(isPaymentRejected(forbidden)).toBe(true);
    expect(forbidden?.code).toBe('HTTP_403');
    expect(forbidden?.message).toContain('HTTP 403');

    const throttled = gatewayRefusalOf(apiError(429, '<html>Too Many Requests</html>'));
    expect(isPaymentRejected(throttled)).toBe(true);
    expect(isPaymentRetryable(throttled)).toBe(false);
    expect(throttled?.code).toBe('HTTP_429');

    expect(gatewayRefusalOf(apiError(400, { error: 'bad' }))?.code).toBe('HTTP_400');
    expect(gatewayRefusalOf(apiError(400, null))?.code).toBe('HTTP_400');
    expect(gatewayRefusalOf({ status: 403 })?.code).toBe('HTTP_403');
  });

  it("reads a body with only one of code and message as not the gateway's error", () => {
    expect(gatewayRefusalOf(apiError(400, { code: 'X' }))?.code).toBe('HTTP_400');
    expect(gatewayRefusalOf(apiError(400, { message: 'm' }))?.code).toBe('HTTP_400');
  });

  it('leaves an error naming a payment_id as an unknown outcome, whatever its classification', () => {
    // It comes from after the payment was created, so "nothing was charged" may be false.
    const relayed = { ...(RETRYABLE_BODY as Record<string, unknown>), payment_id: 'pay_1' };
    expect(gatewayRefusalOf({ status: 503, body: relayed })).toBeUndefined();
    expect(gatewayRefusalOf({ status: 400, body: relayed })).toBeUndefined();
    // An empty payment_id names no payment.
    const unnamed = { ...(RETRYABLE_BODY as Record<string, unknown>), payment_id: '' };
    expect(isPaymentRetryable(gatewayRefusalOf({ status: 503, body: unnamed }))).toBe(true);
  });

  it.each(['CONFLICT', 'CONFLICT_DUPLICATE_INTENT', 'PAYMENT_EXPIRED'] as const)(
    'leaves %s, a 4xx classified reconcile-then-decide, as an unknown outcome',
    (code) => {
      const answer = gatewayAnswer(code);
      expect(answer.status).toBeLessThan(500);
      expect(answer.body).toMatchObject({ retry_classification: 'RECONCILE_THEN_DECIDE' });
      expect(gatewayRefusalOf(answer)).toBeUndefined();
    },
  );

  it("leaves a 5xx whose body is not the gateway's error as an unknown outcome", () => {
    expect(gatewayRefusalOf(apiError(503, '<html>Service Unavailable</html>'))).toBeUndefined();
    expect(gatewayRefusalOf(apiError(502, null))).toBeUndefined();
    expect(gatewayRefusalOf({ status: 500 })).toBeUndefined();
  });

  it('accepts { status, body } from a plain HTTP call', () => {
    expect(isPaymentRetryable(gatewayRefusalOf({ status: 503, body: RETRYABLE_BODY }))).toBe(true);
  });
});
