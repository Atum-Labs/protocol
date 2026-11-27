/**
 * TVM (Tron) release-witness TIP-712 typed data and digest.
 *
 * Counterpart of the Go encoder's `EscrowReleaseEncoder.BuildTypedDataWithQuoteHash` /
 * `DigestWithQuoteHash` (../../go/encoding/release_encoder.go). TIP-712 is EIP-712 hashing with the
 * chainId masked to its lower 4 bytes. The eleven members match `RELEASE_WITNESS_TYPE_HASH` in
 * contracts/tvm/source/contracts/Escrow.sol, byte-identical to the EVM constant, asserted against
 * that source by witness-typehash.test.ts. Declared locally so this package stays independently
 * vendorable.
 */

import { TypedDataEncoder } from 'ethers';
import { normalizeAddress } from './tron-address';
import { maskedChainIdToHex, normalizeBytes32, normalizeUint256 } from './witness-values';

/**
 * TIP-712 types for the eleven-member ReleaseWitness.
 *
 * Exported so the source-tie guard hashes THE SAME OBJECT the encoder hashes
 * rather than a copy of it — a guard asserting on its own duplicate of the type
 * map proves nothing about the encoder.
 */
export const RELEASE_WITNESS_TYPES_WITH_QUOTE_HASH = {
  ReleaseWitness: [
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
 * The eleven-member ReleaseWitness. Mirrors `IEscrow.ReleaseWitness` in
 * contracts/tvm/source/contracts/interfaces/IEscrow.sol member-for-member.
 * Addresses may be Tron base58 or hex; they are normalized internally.
 */
export interface TvmReleaseWitnessWithQuoteHash {
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

export interface TvmReleaseDigestWithQuoteHashInput {
  /** Escrow contract address (base58 or hex), the TIP-712 verifyingContract. */
  escrowContract: string;
  /** Raw Tron block.chainid; masked to 32 bits internally. */
  chainId: number;
  witness: TvmReleaseWitnessWithQuoteHash;
}

/**
 * Build the TIP-712 prehash for the eleven-member ReleaseWitness, shaped for
 * direct `wallet.signTypedData(domain, types, message)` consumption.
 *
 * Serialization, as for the deposit prehash in deposit-encoder.ts:
 *  - `types` omits an EIP712Domain entry (`ethers` derives it from the domain keys
 *    and rejects an explicit one). The Go builder does carry that entry, so the
 *    JSON is not a byte-for-byte copy of Go's — the DIGEST is what is identical.
 *  - `chainId` is pre-masked and rendered as a lowercase hex string.
 *  - addresses go through `normalizeAddress`, so base58 is accepted, a bad
 *    base58check checksum is REJECTED, and the 0x41 prefix is stripped. The result
 *    is lowercase hex, which is this package's wire convention; Go emits the
 *    EIP-55 form of the same 20 bytes, and both hash identically.
 */
export function buildTvmReleaseTypedDataWithQuoteHash(input: TvmReleaseDigestWithQuoteHashInput) {
  const w = input.witness;
  return {
    types: RELEASE_WITNESS_TYPES_WITH_QUOTE_HASH,
    primaryType: 'ReleaseWitness',
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
 * ReleaseWitness, under the Escrow domain {name:"Escrow", version:"3"} with a
 * 32-bit-masked chainId.
 *
 * @returns the 0x-prefixed 32-byte digest.
 */
export function computeTvmReleaseDigestWithQuoteHash(
  input: TvmReleaseDigestWithQuoteHashInput,
): string {
  const prehash = buildTvmReleaseTypedDataWithQuoteHash(input);
  return TypedDataEncoder.hash(prehash.domain, prehash.types, prehash.message);
}
