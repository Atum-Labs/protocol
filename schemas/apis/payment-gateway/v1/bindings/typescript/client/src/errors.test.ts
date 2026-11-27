import { ApiError } from './generated/core/ApiError';
import type { ApiRequestOptions } from './generated/core/ApiRequestOptions';
import type { ApiResult } from './generated/core/ApiResult';
import { getErrorResponse, isApiError } from './errors';

/** Build an ApiError whose parsed body is `body`, as the generated client does. */
function makeApiError(body: unknown, status = 400): ApiError {
  const request: ApiRequestOptions = { method: 'POST', url: '/v1/payments' };
  const response: ApiResult = {
    url: 'https://gateway.example/v1/payments',
    ok: false,
    status,
    statusText: 'Bad Request',
    body,
  };
  return new ApiError(request, response, 'Bad Request');
}

describe('isApiError', () => {
  it('is true for an ApiError and false otherwise', () => {
    expect(isApiError(makeApiError({}))).toBe(true);
    expect(isApiError(new Error('nope'))).toBe(false);
    expect(isApiError('nope')).toBe(false);
    expect(isApiError(undefined)).toBe(false);
  });
});

describe('getErrorResponse', () => {
  it('returns the typed ErrorResponse when the body carries the public shape', () => {
    const body = {
      code: 'INSUFFICIENT_LIQUIDITY',
      message: 'No settler could fulfill the payment.',
      request_id: 'req_123',
      docs_url: 'https://docs.atum.xyz/errors#insufficient-liquidity',
      domain: 'PAYMENT_GATEWAY',
    };
    const result = getErrorResponse(makeApiError(body));
    expect(result).toEqual(body);
    // Narrowed: the fields are directly readable.
    expect(result?.code).toBe('INSUFFICIENT_LIQUIDITY');
    expect(result?.request_id).toBe('req_123');
  });

  it('narrows payment_id on a settlement failure, alongside request_id', () => {
    const body = {
      code: 'SETTLEMENT_FAILED',
      message: "We couldn't complete the settlement for this payment.",
      request_id: 'req_123',
      payment_id: '0xc7108e200d11580e7e75185991084b42a535af588ba8267cd0d1e7df089e5c9c',
      domain: 'SETTLER_AGENT',
    };
    const result = getErrorResponse(makeApiError(body));
    expect(result?.payment_id).toBe(
      '0xc7108e200d11580e7e75185991084b42a535af588ba8267cd0d1e7df089e5c9c',
    );
    // The two ids are independent, so reading one must not shadow the other.
    expect(result?.request_id).toBe('req_123');
  });

  it('accepts a minimal body with only the required fields', () => {
    const result = getErrorResponse(makeApiError({ code: 'BAD_REQUEST', message: 'bad' }));
    expect(result).toEqual({ code: 'BAD_REQUEST', message: 'bad' });
  });

  it('returns undefined when the body is not the public error shape', () => {
    expect(getErrorResponse(makeApiError('plain string body'))).toBeUndefined();
    expect(getErrorResponse(makeApiError({ message: 'missing code' }))).toBeUndefined();
    expect(
      getErrorResponse(makeApiError({ code: 500, message: 'code is not a string' })),
    ).toBeUndefined();
    expect(getErrorResponse(makeApiError(null))).toBeUndefined();
    expect(getErrorResponse(makeApiError(undefined))).toBeUndefined();
  });

  it('returns undefined for non-ApiError values', () => {
    expect(getErrorResponse(new Error('network down'))).toBeUndefined();
    expect(getErrorResponse({ code: 'X', message: 'Y' })).toBeUndefined();
    expect(getErrorResponse(undefined)).toBeUndefined();
  });
});
