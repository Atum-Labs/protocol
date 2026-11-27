/**
 * Validation errors for encoder parameters.
 * These mirror the Go binding errors for consistency.
 */

export class EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodingError';
  }
}

export class ZeroDepositRequestHashError extends EncodingError {
  constructor() {
    super('deposit request hash cannot be zero');
    this.name = 'ZeroDepositRequestHashError';
  }
}

export class ZeroDepositorError extends EncodingError {
  constructor() {
    super('depositor cannot be zero');
    this.name = 'ZeroDepositorError';
  }
}

export class ZeroMintError extends EncodingError {
  constructor() {
    super('mint cannot be zero');
    this.name = 'ZeroMintError';
  }
}

export class ZeroAmountError extends EncodingError {
  constructor() {
    super('amount cannot be zero');
    this.name = 'ZeroAmountError';
  }
}

export class ZeroReserverError extends EncodingError {
  constructor() {
    super('reserver cannot be zero');
    this.name = 'ZeroReserverError';
  }
}

export class ZeroReleaserError extends EncodingError {
  constructor() {
    super('releaser cannot be zero');
    this.name = 'ZeroReleaserError';
  }
}

export class ZeroRecipientError extends EncodingError {
  constructor() {
    super('recipient cannot be zero');
    this.name = 'ZeroRecipientError';
  }
}

export class ZeroDepositHashError extends EncodingError {
  constructor() {
    super('deposit hash cannot be zero');
    this.name = 'ZeroDepositHashError';
  }
}

export class InvalidPubkeyLengthError extends EncodingError {
  constructor() {
    super('invalid pubkey length: expected 32 bytes');
    this.name = 'InvalidPubkeyLengthError';
  }
}

export class InvalidBase58Error extends EncodingError {
  constructor() {
    super('invalid base58 encoding');
    this.name = 'InvalidBase58Error';
  }
}

export class InvalidHexError extends EncodingError {
  constructor() {
    super('invalid hex encoding');
    this.name = 'InvalidHexError';
  }
}

/** Thrown when the V2 witness quote hash is all zeros. */
export class ZeroQuoteHashError extends EncodingError {
  constructor() {
    super('quote hash cannot be zero');
    this.name = 'ZeroQuoteHashError';
  }
}

/**
 * The on-chain reserve rejects a zero source amount (`AmountCannotBeZero`), so this does too:
 * reserving zero narrows the deposit to nothing, so release would consume it and pay the settler
 * nothing while the payer's funds came back as surplus — a settled payment that moved no value.
 */
export class ZeroSourceAmountError extends EncodingError {
  constructor() {
    super('source amount cannot be zero');
    this.name = 'ZeroSourceAmountError';
  }
}

/** Thrown when the committed destination is empty. */
export class EmptyDestinationError extends EncodingError {
  constructor() {
    super('destination cannot be empty');
    this.name = 'EmptyDestinationError';
  }
}

/** Thrown when the committed destination exceeds MAX_DESTINATION_LEN bytes. */
export class DestinationTooLongError extends EncodingError {
  constructor() {
    super('destination exceeds the maximum length');
    this.name = 'DestinationTooLongError';
  }
}

/**
 * Thrown when an EscrowDomain field is unusable. The domain guards used to raise a bare `Error`,
 * which an external consumer could not catch by class the way every other guard here allows.
 */
export class InvalidEscrowDomainError extends EncodingError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEscrowDomainError';
  }
}
