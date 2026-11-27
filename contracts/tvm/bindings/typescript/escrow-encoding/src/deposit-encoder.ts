/**
 * TVM (Tron) Permit2 PermitWitnessTransferFrom deposit prehash and TIP-712 digest.
 *
 * Byte-for-byte counterpart of the Go encoder (deposit_encoder.go, `EscrowDepositEncoder`). Same
 * shape as the EVM deposit encoder, with Tron's normalization: the chainId is masked to its lower
 * 4 bytes (Tron's TIP-712 domain uses a uint32 chainId) and every address is converted from base58
 * to bare 20-byte hex (0x41 prefix stripped). The digest and the JSON serialization (key order,
 * `chainId` as lowercase hex) are pinned to the Go output. See deposit-encoder.test.ts.
 */

import { TypedDataEncoder, toUtf8Bytes } from 'ethers';
import { normalizeAddress } from './tron-address';
import { maskedChainIdToHex, normalizeBytes32, normalizeUint256 } from './witness-values';

/**
 * Hash a TVM Permit2 prehash into its TIP-712 digest. The Tron-specific normalization happens in
 * the builder.
 */
export function hashTvmPermitWitnessTransferFrom(prehash: {
  domain: any;
  types: any;
  message: any;
}): string {
  return TypedDataEncoder.hash(prehash.domain, prehash.types, prehash.message);
}

/**
 * TIP-712 types for the Permit2 message with the four-member DepositWitness, byte-identical to the
 * EVM package's map and to DEPOSIT_WITNESS_TYPE_HASH in contracts/tvm/source/contracts/Escrow.sol
 * (asserted in witness-typehash.test.ts). Declared locally so this package stays independently
 * vendorable.
 */
export const PERMIT_WITNESS_TYPES_WITH_DESTINATION = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'DepositWitness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  DepositWitness: [
    { name: 'depositRequestHash', type: 'bytes32' },
    { name: 'destination', type: 'string' },
    { name: 'reserver', type: 'address' },
    { name: 'releaser', type: 'address' },
  ],
};

/**
 * Byte cap the escrow puts on the committed `destination` (MAX_DESTINATION_BYTES in
 * ../../../source/contracts/Escrow.sol), uniform across EVM, TVM and SVM. witness-typehash.test.ts
 * reads the contract's declaration and fails if the two disagree.
 */
export const MAX_DESTINATION_BYTES = 256;

/**
 * Rejects a destination the escrow would refuse. Measured in UTF-8 BYTES to match
 * Solidity's `bytes(destination).length`.
 */
function assertDestinationWithinBounds(destination: string): void {
  if (destination === '') {
    throw new Error(
      'destination is empty: the escrow reverts DestinationCannotBeEmpty, and keccak256("") is a ' +
        'valid bytes32, so this would sign a commitment to no destination',
    );
  }
  const byteLength = toUtf8Bytes(destination).length;
  if (byteLength > MAX_DESTINATION_BYTES) {
    throw new Error(
      `destination is ${byteLength} bytes, over the escrow's MAX_DESTINATION_BYTES of ` +
        `${MAX_DESTINATION_BYTES}: the contract reverts DestinationTooLong`,
    );
  }
}

/** Parameters for a TVM deposit prehash with the four-member DepositWitness. Addresses may be base58 or hex. */
export interface TvmPermitWitnessTransferFromWithDestinationParams {
  /** Raw Tron block.chainid; masked to 32 bits internally. */
  chainId: number;
  permit2Address: string;
  tokenAddress: string;
  /** The permit CAP, not the actual charge (the reserve witness attests that). */
  amount: bigint | string;
  spenderAddress: string;
  nonce: bigint | string;
  deadline: bigint | string;
  /** The depositor's commitment to the offchain deposit request. */
  depositRequestHash: string;
  /**
   * The plaintext payee, hashed byte for byte as keccak256(bytes(destination)). It is not an address
   * field and is never passed through normalizeAddress: base58 segments are case-significant.
   */
  destination: string;
  reserverAddress: string;
  releaserAddress: string;
}

/**
 * Build the TIP-712 prehash for the four-member DepositWitness on Tron: `types` carries no
 * EIP712Domain entry, `chainId` is pre-masked lowercase hex, addresses are base58-aware and
 * 0x41-stripped, and the top-level key order is types, primaryType, domain, message.
 *
 * Counterpart of the Go encoder's `BuildTypedDataWithDestination`.
 *
 * @throws if `destination` is empty or longer than MAX_DESTINATION_BYTES in UTF-8 bytes; the
 * escrow reverts on both.
 */
export function createTvmPermitWitnessTransferFromPrehashWithDestination(
  params: TvmPermitWitnessTransferFromWithDestinationParams,
) {
  assertDestinationWithinBounds(params.destination);
  return {
    types: PERMIT_WITNESS_TYPES_WITH_DESTINATION,
    primaryType: 'PermitWitnessTransferFrom',
    domain: {
      name: 'Permit2',
      chainId: maskedChainIdToHex(params.chainId),
      verifyingContract: normalizeAddress(params.permit2Address),
    },
    message: {
      permitted: {
        token: normalizeAddress(params.tokenAddress),
        amount: normalizeUint256('amount', params.amount),
      },
      spender: normalizeAddress(params.spenderAddress),
      nonce: normalizeUint256('nonce', params.nonce),
      deadline: normalizeUint256('deadline', params.deadline),
      witness: {
        depositRequestHash: normalizeBytes32('depositRequestHash', params.depositRequestHash),
        destination: params.destination,
        reserver: normalizeAddress(params.reserverAddress),
        releaser: normalizeAddress(params.releaserAddress),
      },
    },
  };
}
