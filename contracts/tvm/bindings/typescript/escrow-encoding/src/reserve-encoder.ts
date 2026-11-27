/**
 * TVM (Tron) reserve-witness TIP-712 typed data and digest.
 *
 * Byte-for-byte counterpart of the Go encoder (reserve_encoder.go). TIP-712 is EIP-712 hashing with
 * the chainId masked to its lower 4 bytes; see `maskChainId`. The witness type and Escrow domain
 * match EVM and are declared locally, as the per-chain Go encoders do; the parity vectors keep the
 * four encoders in step.
 */

import { TypedDataEncoder } from 'ethers';
import { normalizeAddress } from './tron-address';
import { maskedChainIdToHex, normalizeBytes32, normalizeUint256 } from './witness-values';

/**
 * TIP-712 types for the four-member ReserveWitness. Exported so the source-tie
 * guard hashes the same object the encoder hashes, not a copy of it.
 */
export const RESERVE_WITNESS_TYPES_WITH_QUOTE_SOURCE = {
  ReserveWitness: [
    { name: 'depositId', type: 'bytes32' },
    { name: 'quoteHash', type: 'bytes32' },
    { name: 'settler', type: 'address' },
    { name: 'sourceAmount', type: 'uint256' },
  ],
};

/**
 * The four-member ReserveWitness. Mirrors `IEscrow.ReserveWitness` in
 * contracts/tvm/source/contracts/interfaces/IEscrow.sol member-for-member.
 * Addresses may be Tron base58 or hex; they are normalized internally.
 */
export interface TvmReserveDigestWithQuoteSourceInput {
  /** Escrow contract address (base58 or hex), the TIP-712 verifyingContract. */
  escrowContract: string;
  /** Raw Tron block.chainid; masked to 32 bits internally. */
  chainId: number;
  /** Contract-generated deposit key. */
  depositId: string;
  /** Offchain quote hash the deposit is reserved against. */
  quoteHash: string;
  /** Settler that may claim the escrowed funds. */
  settler: string;
  /**
   * The winning quote's source amount — the ACTUAL charge the reserver attests,
   * which the escrow moves instead of the permit's cap. Must be <= the permit
   * amount; the contract enforces that, this encoder does not (neither does the
   * sibling Go builder).
   */
  sourceAmount: bigint | string;
}

/**
 * Build the TIP-712 prehash for the four-member ReserveWitness, shaped for direct
 * `wallet.signTypedData(domain, types, message)` consumption. See
 * release-encoder.ts's buildTvmReleaseTypedDataWithQuoteHash for the serialization
 * notes (no EIP712Domain entry, pre-masked hex chainId, base58-aware addresses).
 *
 * Counterpart of the Go encoder's `BuildTypedDataWithQuoteSource`
 * (../../go/encoding/reserve_encoder.go).
 */
export function buildTvmReserveTypedDataWithQuoteSource(
  input: TvmReserveDigestWithQuoteSourceInput,
) {
  return {
    types: RESERVE_WITNESS_TYPES_WITH_QUOTE_SOURCE,
    primaryType: 'ReserveWitness',
    domain: {
      name: 'Escrow',
      version: '3',
      chainId: maskedChainIdToHex(input.chainId),
      verifyingContract: normalizeAddress(input.escrowContract),
    },
    message: {
      depositId: normalizeBytes32('depositId', input.depositId),
      quoteHash: normalizeBytes32('quoteHash', input.quoteHash),
      settler: normalizeAddress(input.settler),
      sourceAmount: normalizeUint256('sourceAmount', input.sourceAmount),
    },
  };
}

/**
 * Computes the TIP-712 digest the reserver signs for the four-member
 * ReserveWitness, under the Escrow domain {name:"Escrow", version:"3"} with a
 * 32-bit-masked chainId.
 *
 * Counterpart of the Go encoder's `DigestWithQuoteSource`.
 *
 * @returns the 0x-prefixed 32-byte digest.
 */
export function computeTvmReserveDigestWithQuoteSource(
  input: TvmReserveDigestWithQuoteSourceInput,
): string {
  const prehash = buildTvmReserveTypedDataWithQuoteSource(input);
  return TypedDataEncoder.hash(prehash.domain, prehash.types, prehash.message);
}
