export abstract class BaseError extends Error {
  public readonly isOperational: boolean;
  public readonly code: string | undefined;

  constructor(name: string, message: string, isOperational: boolean, code?: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = name;
    this.isOperational = isOperational;
    this.code = code;
    Error.captureStackTrace(this);
  }
}

/**
 * Recoverability contract. An unclassified bare `Error` is treated as retryable by default,
 * so a permanent failure must throw `NonRetryableError` explicitly.
 */
export class RetryableError extends BaseError {
  constructor(
    message: string,
    override readonly cause?: Error,
    code?: string,
  ) {
    super('RetryableError', message, true, code);
  }
}

export class NonRetryableError extends BaseError {
  constructor(
    message: string,
    override readonly cause?: Error,
    code?: string,
  ) {
    super('NonRetryableError', message, true, code);
  }
}

/** Canonical error codes emitted by every signer, policy layer, and provider. */
export const SignerErrorCode = Object.freeze({
  NONCE_TOO_LOW: 'NONCE_TOO_LOW',
  NONCE_TOO_HIGH: 'NONCE_TOO_HIGH',
  REPLACEMENT_UNDERPRICED: 'REPLACEMENT_UNDERPRICED',
  TX_EXPIRED: 'TX_EXPIRED',

  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  POLICY_REJECTED: 'POLICY_REJECTED',
  POLICY_TX_KIND_MISMATCH: 'POLICY_TX_KIND_MISMATCH',
  SIGNER_ADDRESS_DRIFT: 'SIGNER_ADDRESS_DRIFT',
  SIGNER_NOT_INITIALIZED: 'SIGNER_NOT_INITIALIZED',
  SIGNER_CAPABILITY_MISMATCH: 'SIGNER_CAPABILITY_MISMATCH',

  TURNKEY_AUTH: 'TURNKEY_AUTH',
  TURNKEY_NETWORK: 'TURNKEY_NETWORK',
  TURNKEY_RATE_LIMITED: 'TURNKEY_RATE_LIMITED',
  TURNKEY_BAD_RESPONSE: 'TURNKEY_BAD_RESPONSE',
  TURNKEY_ACTIVITY_FAILED: 'TURNKEY_ACTIVITY_FAILED',
  TURNKEY_SIGNER_UNAVAILABLE: 'TURNKEY_SIGNER_UNAVAILABLE',
} as const);

export type SignerErrorCode = (typeof SignerErrorCode)[keyof typeof SignerErrorCode];

export function signerRetryable(
  code: SignerErrorCode,
  message: string,
  cause?: Error,
): RetryableError {
  return new RetryableError(`${code}: ${message}`, cause, code);
}

export function signerTerminal(
  code: SignerErrorCode,
  message: string,
  cause?: Error,
): NonRetryableError {
  return new NonRetryableError(`${code}: ${message}`, cause, code);
}
