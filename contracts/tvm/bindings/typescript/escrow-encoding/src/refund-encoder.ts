/**
 * TVM (Tron) refund-witness TIP-712 typed data and digest.
 *
 * Counterpart of the Go encoder's `EscrowRefundEncoder.BuildTypedDataWithQuoteHash` /
 * `DigestWithQuoteHash` (../../go/encoding/refund_encoder.go), and the twin of release-encoder.ts:
 * the same eleven members, differing only in the struct name, so a release signature can never be
 * replayed as a refund. Asserted against `REFUND_WITNESS_TYPE_HASH` in Escrow.sol by
 * witness-typehash.test.ts.
 */

import { TypedDataEncoder } from 'ethers';
import { normalizeAddress } from './tron-address';
import { maskedChainIdToHex, normalizeBytes32, normalizeUint256 } from './witness-values';

/**
 * TIP-712 types for the eleven-member RefundWitness. Exported so the source-tie
 * guard hashes the same object the encoder hashes, not a copy of it.
 */
export const REFUND_WITNESS_TYPES_WITH_QUOTE_HASH = {
  RefundWitness: [
    { name: 'depositId', type: 'bytes32' },
    { name: 'quoteHash', type: 'bytes32' },
    { name: 'depositRequestHash', type: 'bytes32' },
    { name: 'destinationHash', type: 'bytes32' },
    { name: 'depositor', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'reserver', type: 'address' },
    { name: 'releaser', type: 'address' },
    { name: 'settler', type: 'address' },
  ],
};

/**
 * The eleven-member RefundWitness. Mirrors `IEscrow.RefundWitness` in
 * contracts/tvm/source/contracts/interfaces/IEscrow.sol member-for-member.
 * Addresses may be Tron base58 or hex; they are normalized internally.
 */
export interface TvmRefundWitnessWithQuoteHash {
  /** Contract-generated deposit key. */
  depositId: string;
  /** Offchain quote hash the deposit was reserved against. */
  quoteHash: string;
  /** The depositor's commitment to the offchain deposit request. */
  depositRequestHash: string;
  /** keccak256 of the depositor's plaintext `destination` string. */
  destinationHash: string;
  depositor: string;
  token: string;
  /** Source amount returned to the depositor, smallest units. */
  amount: bigint | string;
  /** Protocol fee retained by the escrow, smallest units. */
  feeAmount: bigint | string;
  reserver: string;
  releaser: string;
  settler: string;
}

export interface TvmRefundDigestWithQuoteHashInput {
  /** Escrow contract address (base58 or hex), the TIP-712 verifyingContract. */
  escrowContract: string;
  /** Raw Tron block.chainid; masked to 32 bits internally. */
  chainId: number;
  witness: TvmRefundWitnessWithQuoteHash;
}

/**
 * Build the TIP-712 prehash for the eleven-member RefundWitness. See
 * buildTvmReleaseTypedDataWithQuoteHash for the serialization notes (no
 * EIP712Domain entry, pre-masked hex chainId, base58-aware address normalization).
 */
export function buildTvmRefundTypedDataWithQuoteHash(input: TvmRefundDigestWithQuoteHashInput) {
  const w = input.witness;
  return {
    types: REFUND_WITNESS_TYPES_WITH_QUOTE_HASH,
    primaryType: 'RefundWitness',
    domain: {
      name: 'Escrow',
      version: '3',
      chainId: maskedChainIdToHex(input.chainId),
      verifyingContract: normalizeAddress(input.escrowContract),
    },
    message: {
      depositId: normalizeBytes32('depositId', w.depositId),
      quoteHash: normalizeBytes32('quoteHash', w.quoteHash),
      depositRequestHash: normalizeBytes32('depositRequestHash', w.depositRequestHash),
      destinationHash: normalizeBytes32('destinationHash', w.destinationHash),
      depositor: normalizeAddress(w.depositor),
      token: normalizeAddress(w.token),
      amount: normalizeUint256('amount', w.amount),
      feeAmount: normalizeUint256('feeAmount', w.feeAmount),
      reserver: normalizeAddress(w.reserver),
      releaser: normalizeAddress(w.releaser),
      settler: normalizeAddress(w.settler),
    },
  };
}

/**
 * Computes the TIP-712 digest the releaser signs for the eleven-member
 * RefundWitness, under the Escrow domain {name:"Escrow", version:"3"} with a
 * 32-bit-masked chainId.
 *
 * @returns the 0x-prefixed 32-byte digest.
 */
export function computeTvmRefundDigestWithQuoteHash(
  input: TvmRefundDigestWithQuoteHashInput,
): string {
  const prehash = buildTvmRefundTypedDataWithQuoteHash(input);
  return TypedDataEncoder.hash(prehash.domain, prehash.types, prehash.message);
}
