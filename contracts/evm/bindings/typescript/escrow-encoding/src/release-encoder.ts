/**
 * EVM release-witness EIP-712 typed data and digest.
 *
 * Counterpart of the Go encoder's `EscrowReleaseEncoder.BuildTypedDataWithQuoteHash` /
 * `DigestWithQuoteHash` (../../go/encoding/release_encoder.go). The releaser signs the digest this
 * produces. witness-typehash.test.ts asserts the type map reproduces `RELEASE_WITNESS_TYPE_HASH`
 * read from contracts/evm/source/src/Escrow.sol, and recomputes the digest the way the contract
 * does to pin which value lands in which member.
 */

import { TypedDataEncoder } from 'ethers';
import { RELEASE_WITNESS_TYPES_WITH_QUOTE_HASH } from './permit-types';
import {
  chainIdToHex,
  normalizeAddressField,
  normalizeBytes32,
  normalizeUint256,
} from './witness-values';

/**
 * The eleven-member ReleaseWitness. Mirrors `IEscrow.ReleaseWitness` in
 * contracts/evm/source/src/interfaces/IEscrow.sol member-for-member, in order.
 */
export interface ReleaseWitnessWithQuoteHash {
  /** Contract-generated deposit key. */
  depositId: string;
  /** Offchain quote hash the fill was awarded against. */
  quoteHash: string;
  /** The depositor's commitment to the offchain deposit request. */
  depositRequestHash: string;
  /** keccak256 of the depositor's plaintext `destination` string. */
  destinationHash: string;
  depositor: string;
  token: string;
  /** Source amount released to the settler, smallest units. */
  amount: bigint | string;
  /** Protocol fee retained by the escrow, smallest units. */
  feeAmount: bigint | string;
  reserver: string;
  releaser: string;
  settler: string;
}

export interface ReleaseDigestWithQuoteHashInput {
  /** Escrow contract address (EVM hex), the EIP-712 verifyingContract. */
  escrowContract: string;
  /** EIP-155 chain ID. */
  chainId: number;
  witness: ReleaseWitnessWithQuoteHash;
}

/**
 * Build the structured prehash for the eleven-member ReleaseWitness, shaped for
 * direct `wallet.signTypedData(domain, types, message)` consumption.
 *
 * Serialization, as for the deposit prehash in deposit-encoder.ts:
 *  - `types` omits an EIP712Domain entry, because `ethers` derives it from the
 *    domain object's keys and REJECTS an explicit one. The Go builder does carry
 *    that entry, so the JSON is not a byte-for-byte copy of Go's — the DIGEST is
 *    what is byte-identical across the two.
 *  - `chainId` is a lowercase hex string, matching Go's `math.HexOrDecimal256`
 *    marshalling. The digest is invariant to that choice.
 *  - Key order follows the witness member order, so the serialized message reads
 *    in the same order the typehash commits to.
 */
export function buildReleaseTypedDataWithQuoteHash(input: ReleaseDigestWithQuoteHashInput) {
  const w = input.witness;
  return {
    types: RELEASE_WITNESS_TYPES_WITH_QUOTE_HASH,
    primaryType: 'ReleaseWitness',
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
 * ReleaseWitness, under the Escrow domain {name:"Escrow", version:"3"}.
 *
 * @returns the 0x-prefixed 32-byte digest.
 */
export function computeReleaseDigestWithQuoteHash(
  input: ReleaseDigestWithQuoteHashInput,
): string {
  const prehash = buildReleaseTypedDataWithQuoteHash(input);
  return TypedDataEncoder.hash(prehash.domain, prehash.types, prehash.message);
}
