/**
 * EVM reserve-witness EIP-712 typed data and digest.
 *
 * Byte-for-byte counterpart of the Go encoder (reserve_encoder.go). The reserver signs the digest
 * this returns, so it is pinned to the Go output by the parity tests.
 */

import { TypedDataEncoder } from 'ethers';
import { RESERVE_WITNESS_TYPES_WITH_QUOTE_SOURCE } from './permit-types';
import {
  chainIdToHex,
  normalizeAddressField,
  normalizeBytes32,
  normalizeUint256,
} from './witness-values';

/**
 * The four-member ReserveWitness. Mirrors `IEscrow.ReserveWitness` in
 * contracts/evm/source/src/interfaces/IEscrow.sol member-for-member, in order.
 */
export interface ReserveDigestWithQuoteSourceInput {
  /** Escrow contract address (EVM hex), the EIP-712 verifyingContract. */
  escrowContract: string;
  /** EIP-155 chain ID. */
  chainId: number;
  /** Contract-generated deposit key. */
  depositId: string;
  /** Offchain quote hash the deposit is reserved against. */
  quoteHash: string;
  /** Settler that may claim the escrowed funds. */
  settler: string;
  /** The winning quote's source amount: the actual charge, at most the permit amount (the escrow enforces it). */
  sourceAmount: bigint | string;
}

/**
 * Build the structured prehash for the four-member ReserveWitness, shaped for
 * direct `wallet.signTypedData(domain, types, message)` consumption. See
 * release-encoder.ts's buildReleaseTypedDataWithQuoteHash for why `types` omits
 * EIP712Domain and why `chainId` is a lowercase hex string.
 *
 * Counterpart of the Go encoder's `BuildTypedDataWithQuoteSource`
 * (../../go/encoding/reserve_encoder.go).
 */
export function buildReserveTypedDataWithQuoteSource(input: ReserveDigestWithQuoteSourceInput) {
  return {
    types: RESERVE_WITNESS_TYPES_WITH_QUOTE_SOURCE,
    primaryType: 'ReserveWitness',
    domain: {
      name: 'Escrow',
      version: '3',
      chainId: chainIdToHex(input.chainId),
      verifyingContract: normalizeAddressField('escrowContract', input.escrowContract),
    },
    message: {
      depositId: normalizeBytes32('depositId', input.depositId),
      quoteHash: normalizeBytes32('quoteHash', input.quoteHash),
      settler: normalizeAddressField('settler', input.settler),
      sourceAmount: normalizeUint256('sourceAmount', input.sourceAmount),
    },
  };
}

/**
 * Computes the EIP-712 digest the reserver signs for the four-member
 * ReserveWitness, under the Escrow domain {name:"Escrow", version:"3"}.
 *
 * Counterpart of the Go encoder's `DigestWithQuoteSource`.
 *
 * @returns the 0x-prefixed 32-byte digest.
 */
export function computeReserveDigestWithQuoteSource(
  input: ReserveDigestWithQuoteSourceInput,
): string {
  const prehash = buildReserveTypedDataWithQuoteSource(input);
  return TypedDataEncoder.hash(prehash.domain, prehash.types, prehash.message);
}
