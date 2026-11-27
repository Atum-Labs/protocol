/**
 * Validation errors for encoder parameters.
 * These mirror the Go binding errors for consistency, and the contract's own errors where one exists.
 */

export class EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodingError';
  }
}

/** DepositRequestHashCannotBeEmpty on chain. */
export class ZeroDepositRequestHashError extends EncodingError {
  constructor() {
    super('deposit request hash cannot be zero');
    this.name = 'ZeroDepositRequestHashError';
  }
}

/** DestinationCannotBeEmpty on chain. */
export class EmptyDestinationError extends EncodingError {
  constructor() {
    super('destination cannot be empty');
    this.name = 'EmptyDestinationError';
  }
}

/** DestinationTooLong on chain. */
export class DestinationTooLongError extends EncodingError {
  constructor() {
    super('destination exceeds the maximum length');
    this.name = 'DestinationTooLongError';
  }
}

/** ReserverCannotBeZero on chain. */
export class ZeroReserverError extends EncodingError {
  constructor() {
    super('reserver cannot be zero');
    this.name = 'ZeroReserverError';
  }
}

/** ReleaserCannotBeZero on chain. */
export class ZeroReleaserError extends EncodingError {
  constructor() {
    super('releaser cannot be zero');
    this.name = 'ZeroReleaserError';
  }
}

/** InvalidAmount on chain: the deposit ceiling is not positive. */
export class ZeroAmountError extends EncodingError {
  constructor() {
    super('amount cannot be zero');
    this.name = 'ZeroAmountError';
  }
}

/** InvalidSourceAmount on chain: reserving zero would settle a payment that moved no value. */
export class ZeroSourceAmountError extends EncodingError {
  constructor() {
    super('source amount cannot be zero');
    this.name = 'ZeroSourceAmountError';
  }
}

/** InvalidSourceAmount on chain: the charge exceeds the signed ceiling. */
export class InvalidSourceAmountError extends EncodingError {
  constructor() {
    super('source amount exceeds the deposit amount');
    this.name = 'InvalidSourceAmountError';
  }
}

/** An amount that is not a bigint in 0..=2^127-1, so it has no 16-byte encoding the contract produces. */
export class AmountOutOfRangeError extends EncodingError {
  constructor() {
    super('amount must be an i128 between 0 and 2^127-1');
    this.name = 'AmountOutOfRangeError';
  }
}

export class ZeroDepositIdError extends EncodingError {
  constructor() {
    super('deposit id cannot be zero');
    this.name = 'ZeroDepositIdError';
  }
}

/** QuoteHashCannotBeEmpty on chain. Unlike Solana, the Soroban release and refund enforce it too. */
export class ZeroQuoteHashError extends EncodingError {
  constructor() {
    super('quote hash cannot be zero');
    this.name = 'ZeroQuoteHashError';
  }
}

/** InconsistentTimestamps on chain. */
export class InconsistentTimestampsError extends EncodingError {
  constructor() {
    super('issued_at is after deadline');
    this.name = 'InconsistentTimestampsError';
  }
}

/** DeadlineTooFarInFuture on chain. */
export class DeadlineTooFarInFutureError extends EncodingError {
  constructor() {
    super('deadline is more than 24 hours after issued_at');
    this.name = 'DeadlineTooFarInFutureError';
  }
}

/** A hash field that is not exactly 32 bytes. Go's fixed-size arrays make this structural there. */
export class InvalidFieldLengthError extends EncodingError {
  constructor(field: string, got: number) {
    super(`${field} must be 32 bytes, got ${got}`);
    this.name = 'InvalidFieldLengthError';
  }
}

/** A destination that is not valid UTF-8 (a lone UTF-16 surrogate in JS), so its hash would not be the contract's. */
export class InvalidDestinationError extends EncodingError {
  constructor() {
    super('destination must be well-formed UTF-8');
    this.name = 'InvalidDestinationError';
  }
}

export class InvalidEscrowDomainError extends EncodingError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEscrowDomainError';
  }
}

/** Not a well-formed G... or C... strkey, including a secret seed, which is never accepted. */
export class InvalidStrkeyError extends EncodingError {
  constructor(reason: string) {
    super(`invalid strkey: ${reason}`);
    this.name = 'InvalidStrkeyError';
  }
}

/** UnsupportedAddress on chain: muxed (M...) and claimable-balance (B...) have no fixed-width form. */
export class UnsupportedAddressError extends EncodingError {
  constructor() {
    super('unsupported address type: only G... accounts and C... contracts have a fixed-width form');
    this.name = 'UnsupportedAddressError';
  }
}

export class InvalidPubkeyLengthError extends EncodingError {
  constructor() {
    super('invalid key length: expected 32 bytes');
    this.name = 'InvalidPubkeyLengthError';
  }
}

export class InvalidHexError extends EncodingError {
  constructor() {
    super('invalid hex encoding');
    this.name = 'InvalidHexError';
  }
}
