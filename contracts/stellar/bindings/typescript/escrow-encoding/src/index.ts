/**
 * @atum-labs/stellar-escrow-encoding
 *
 * TypeScript bindings for Stellar (Soroban) escrow digest generation.
 * This package mirrors the sibling Go escrow-encoding package; the byte layouts are
 * contracts/stellar/source/docs/witness-layouts.md.
 */

// Address and key types
export { Address, ACCOUNT_ADDRESS, CONTRACT_ADDRESS } from './address';
export type { AddressType } from './address';
export { Pubkey } from './pubkey';

// Encoding utilities
export {
  encodeU64LE,
  encodeAmount16,
  keccak256,
  stringToBytes,
  isZeroBytes32,
  requireBytes32,
  MAX_I128,
} from './encoding-utils';

// Escrow domain separation (network_id, contract_id)
export type { EscrowDomain } from './escrow-domain';
export {
  escrowDomainPrefixBytes,
  newEscrowDomain,
  networkIdFromPassphrase,
  SIGNATURE_DOMAIN_VERSION,
  PASSPHRASE_TESTNET,
  PASSPHRASE_PUBLIC,
} from './escrow-domain';

// Errors
export {
  EncodingError,
  ZeroDepositRequestHashError,
  EmptyDestinationError,
  DestinationTooLongError,
  ZeroReserverError,
  ZeroReleaserError,
  ZeroAmountError,
  ZeroSourceAmountError,
  InvalidSourceAmountError,
  AmountOutOfRangeError,
  ZeroDepositIdError,
  ZeroQuoteHashError,
  InconsistentTimestampsError,
  DeadlineTooFarInFutureError,
  InvalidFieldLengthError,
  InvalidDestinationError,
  InvalidEscrowDomainError,
  InvalidStrkeyError,
  UnsupportedAddressError,
  InvalidPubkeyLengthError,
  InvalidHexError,
} from './errors';

// Deposit encoder
export type { EscrowDepositParams } from './deposit-encoder';
export {
  computeDepositHash,
  computeDestinationHash,
  MAX_DESTINATION_LEN,
  MAX_DEPOSIT_VALIDITY_SECS,
} from './deposit-encoder';

// Reserve encoder
export type { EscrowReserveParams } from './reserve-encoder';
export { computeReserveHash, checkSourceAmount } from './reserve-encoder';

// Release and refund encoders
export type { EscrowSettlementParams, EscrowReleaseParams } from './release-encoder';
export { computeReleaseHash } from './release-encoder';
export type { EscrowRefundParams } from './refund-encoder';
export { computeRefundHash } from './refund-encoder';

// Delegate renounce encoder
export type { EscrowRenounceParams } from './renounce-encoder';
export { computeRenounceHash } from './renounce-encoder';

// Stored active-deposit hash
export type { EscrowActiveDeposit } from './active-deposit';
export { computeActiveDepositHash } from './active-deposit';
