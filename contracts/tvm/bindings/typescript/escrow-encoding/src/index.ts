/**
 * @atum-labs/tvm-escrow-encoding
 *
 * TypeScript bindings for TVM (Tron) escrow encoding: the Tron-specific chain id mask and address
 * normalization, and the deposit, reserve, release and refund witness encoders.
 */

// Chain ID utilities
export { maskChainId } from './chain-id';

// Tron address normalization (base58check-validated, 0x41-prefix stripped)
export { base58ToHex, normalizeAddress } from './tron-address';

// Deposit id derivation with Tron address normalization
export { computePaymentId } from './payment-id';

// Reserve witness {depositId, quoteHash, settler, sourceAmount}
export {
  RESERVE_WITNESS_TYPES_WITH_QUOTE_SOURCE,
  buildTvmReserveTypedDataWithQuoteSource,
  computeTvmReserveDigestWithQuoteSource,
} from './reserve-encoder';
export type { TvmReserveDigestWithQuoteSourceInput } from './reserve-encoder';

// Release and refund witnesses
export {
  RELEASE_WITNESS_TYPES_WITH_QUOTE_HASH,
  buildTvmReleaseTypedDataWithQuoteHash,
  computeTvmReleaseDigestWithQuoteHash,
} from './release-encoder';
export type {
  TvmReleaseWitnessWithQuoteHash,
  TvmReleaseDigestWithQuoteHashInput,
} from './release-encoder';

export {
  REFUND_WITNESS_TYPES_WITH_QUOTE_HASH,
  buildTvmRefundTypedDataWithQuoteHash,
  computeTvmRefundDigestWithQuoteHash,
} from './refund-encoder';
export type {
  TvmRefundWitnessWithQuoteHash,
  TvmRefundDigestWithQuoteHashInput,
} from './refund-encoder';

// Permit2 PermitWitnessTransferFrom deposit {depositRequestHash, destination, reserver, releaser}
export {
  PERMIT_WITNESS_TYPES_WITH_DESTINATION,
  createTvmPermitWitnessTransferFromPrehashWithDestination,
  hashTvmPermitWitnessTransferFrom,
  MAX_DESTINATION_BYTES,
} from './deposit-encoder';
export type { TvmPermitWitnessTransferFromWithDestinationParams } from './deposit-encoder';
