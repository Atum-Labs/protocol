/**
 * EVM refund-witness EIP-712 typed data and digest.
 *
 * Counterpart of the Go encoder's `EscrowRefundEncoder.BuildTypedDataWithQuoteHash` /
 * `DigestWithQuoteHash` (../../go/encoding/refund_encoder.go), and the twin of release-encoder.ts:
 * the same eleven members, differing only in the struct name, which is part of the type string, so
 * a release signature can never be replayed as a refund. witness-typehash.test.ts asserts the type
 * map against `REFUND_WITNESS_TYPE_HASH` read from Escrow.sol.
 */

import { TypedDataEncoder } from 'ethers';
import { REFUND_WITNESS_TYPES_WITH_QUOTE_HASH } from './permit-types';
import {
  chainIdToHex,
  normalizeAddressField,
  normalizeBytes32,
  normalizeUint256,
} from './witness-values';

/**
 * The eleven-member RefundWitness. Mirrors `IEscrow.RefundWitness` in
 * contracts/evm/source/src/interfaces/IEscrow.sol member-for-member, in order.
 */
export interface RefundWitnessWithQuoteHash {
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

export interface RefundDigestWithQuoteHashInput {
  /** Escrow contract address (EVM hex), the EIP-712 verifyingContract. */
  escrowContract: string;
  /** EIP-155 chain ID. */
  chainId: number;
  witness: RefundWitnessWithQuoteHash;
}

/**
 * Build the structured prehash for the eleven-member RefundWitness, shaped for
 * direct `wallet.signTypedData(domain, types, message)` consumption. See
 * buildReleaseTypedDataWithQuoteHash for why `types` omits EIP712Domain and why
 * `chainId` is a hex string.
 */
export function buildRefundTypedDataWithQuoteHash(input: RefundDigestWithQuoteHashInput) {
  const w = input.witness;
  return {
    types: REFUND_WITNESS_TYPES_WITH_QUOTE_HASH,
    primaryType: 'RefundWitness',
    domain: {
      name: 'Escrow',
      version: '3',
      chainId: chainIdToHex(input.chainId),
      verifyingContract: normalizeAddressField('escrowContract', input.escrowContract),
    },
    message: {
      depositId: normalizeBytes32('depositId', w.depositId),
      quoteHash: normalizeBytes32('quoteHash', w.quoteHash),
      depositRequestHash: normalizeBytes32('depositRequestHash', w.depositRequestHash),
      destinationHash: normalizeBytes32('destinationHash', w.destinationHash),
      depositor: normalizeAddressField('depositor', w.depositor),
      token: normalizeAddressField('token', w.token),
      amount: normalizeUint256('amount', w.amount),
      feeAmount: normalizeUint256('feeAmount', w.feeAmount),
      reserver: normalizeAddressField('reserver', w.reserver),
      releaser: normalizeAddressField('releaser', w.releaser),
      settler: normalizeAddressField('settler', w.settler),
    },
  };
}

/**
 * Computes the EIP-712 digest the releaser signs for the eleven-member
 * RefundWitness, under the Escrow domain {name:"Escrow", version:"3"}.
 *
 * @returns the 0x-prefixed 32-byte digest.
 */
export function computeRefundDigestWithQuoteHash(input: RefundDigestWithQuoteHashInput): string {
  const prehash = buildRefundTypedDataWithQuoteHash(input);
  return TypedDataEncoder.hash(prehash.domain, prehash.types, prehash.message);
}
