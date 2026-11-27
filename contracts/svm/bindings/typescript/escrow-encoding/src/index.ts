/**
 * @atum-labs/solana-escrow-encoding
 *
 * TypeScript bindings for Solana escrow message hash generation.
 * This package mirrors the sibling Go escrow-encoding package.
 */

// Pubkey type
export { Pubkey } from './pubkey';

// Encoding utilities
export { encodeU64LE, keccak256, stringToBytes, isZeroBytes32 } from './encoding-utils';

// V3 escrow domain separation (cluster_id, signature_domain_version, program_id)
export { EscrowDomain, escrowDomainPrefixBytes, newEscrowDomain } from './escrow-domain';

// Errors
export {
  EncodingError,
  ZeroDepositRequestHashError,
  ZeroQuoteHashError,
  EmptyDestinationError,
  DestinationTooLongError,
  ZeroDepositorError,
  ZeroMintError,
  ZeroAmountError,
  ZeroReserverError,
  ZeroReleaserError,
  ZeroRecipientError,
  ZeroDepositHashError,
  ZeroSourceAmountError,
  InvalidEscrowDomainError,
  InvalidPubkeyLengthError,
  InvalidBase58Error,
  InvalidHexError,
} from './errors';

// Deposit encoder
export {
  EscrowDepositParams,
  computeDepositHash,
  computeDepositHashV2,
  computeDestinationHash,
  MAX_DESTINATION_LEN,
} from './deposit-encoder';

// Reserve encoder
export {
  EscrowReserveParams,
  computeReserveHash,
  computeReserveHashV2,
  computeReserveHashV3,
} from './reserve-encoder';

// Release encoder
export { EscrowReleaseParams, computeReleaseHash, computeReleaseHashV2 } from './release-encoder';

// Refund encoder
export { EscrowRefundParams, computeRefundHash, computeRefundHashV2 } from './refund-encoder';

// Nonce generator
export { generateNonce, REPLAY_SLOTS, MAX_VALID_SLOT, REPLAY_BUCKETS, DEPOSIT_COMPUTE_UNIT_LIMIT } from './nonce-generator';

// Message scheme: what an ed25519 signer signs over a witness hash
export { MessageScheme, SCHEME_RAW_HASH, WitnessKind, signingBytes, acceptedForms } from './scheme';

// Anchor IDL and type helper for program interaction
export type { Escrow } from './generated/escrow';
export type { FulfillmentProxy } from './generated/fulfillment_proxy';
