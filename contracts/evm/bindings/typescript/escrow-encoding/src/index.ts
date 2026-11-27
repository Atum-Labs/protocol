/**
 * @atum-labs/evm-escrow-encoding
 *
 * TypeScript bindings for EVM/TVM escrow encoding, shared by EVM and Tron (both use Permit2 and
 * EIP-712/TIP-712).
 */

// Deposit id computation
export { computePaymentIdV2 } from './payment-id';

// Nonce generation
export { generateNonce } from './nonce-generator';

// EIP-712 / TIP-712 domain and witness types
export {
  createPermit2Domain,
  PERMIT_WITNESS_TYPES_WITH_DESTINATION,
  RESERVE_WITNESS_TYPES_WITH_QUOTE_SOURCE,
  RELEASE_WITNESS_TYPES_WITH_QUOTE_HASH,
  REFUND_WITNESS_TYPES_WITH_QUOTE_HASH,
} from './permit-types';

// Escrow contract ABI
export { ESCROW_V3_ABI_JSON } from './escrow-abi';

// Reserve witness {depositId, quoteHash, settler, sourceAmount}
export {
  buildReserveTypedDataWithQuoteSource,
  computeReserveDigestWithQuoteSource,
} from './reserve-encoder';
export type { ReserveDigestWithQuoteSourceInput } from './reserve-encoder';

// Release and refund witnesses
export {
  buildReleaseTypedDataWithQuoteHash,
  computeReleaseDigestWithQuoteHash,
} from './release-encoder';
export type {
  ReleaseWitnessWithQuoteHash,
  ReleaseDigestWithQuoteHashInput,
} from './release-encoder';
export {
  buildRefundTypedDataWithQuoteHash,
  computeRefundDigestWithQuoteHash,
} from './refund-encoder';
export type { RefundWitnessWithQuoteHash, RefundDigestWithQuoteHashInput } from './refund-encoder';

// Permit2 PermitWitnessTransferFrom deposit {depositRequestHash, destination, reserver, releaser}
export {
  createPermitWitnessTransferFromPrehashWithDestination,
  hashPermitWitnessTransferFrom,
  MAX_DESTINATION_BYTES,
  PERMIT2_CONTRACT_ADDRESS,
} from './deposit-encoder';
export type { PermitWitnessTransferFromWithDestinationParams } from './deposit-encoder';

// Direct deposit path: directDeposit and reserve calldata, the funding batch, the deposit
// id, the active-deposit hashes of both states, and the DepositReserved overlay
export {
  DIRECT_DEPOSIT_DOMAIN_TAG,
  DEPOSIT_WITNESS_TYPE_HASH,
  RESERVE_SELECTOR,
  applyDepositReserved,
  buildDirectDepositFundingBatch,
  computeActiveDepositHash,
  computeDepositWitnessHash,
  computeDirectDepositId,
  decodeDepositReservedLog,
  destinationHash,
  encodeDirectDepositCalldata,
  encodeReserveCalldata,
  reservedActiveDeposit,
  unreservedActiveDeposit,
} from './direct-deposit-encoder';
export type {
  ActiveDeposit,
  Call,
  DepositReserved,
  DepositWitness,
  DirectDepositIdParams,
  DirectDepositInput,
  ReserveInput,
  ReserveWitness,
} from './direct-deposit-encoder';
