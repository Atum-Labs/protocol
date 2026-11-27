/**
 * EVM Permit2 PermitWitnessTransferFrom deposit prehash and EIP-712 digest.
 *
 * Byte-for-byte counterpart of the Go encoder (deposit_encoder.go, `EscrowDepositEncoder`). The
 * sender signs the digest, and the serialized prehash travels as `message_prehash`, so both the
 * digest and the JSON serialization (top-level key order, `chainId` as lowercase hex) are pinned
 * to the Go output. See deposit-encoder.test.ts.
 */

import { TypedDataEncoder, toUtf8Bytes } from 'ethers';
import { PERMIT_WITNESS_TYPES_WITH_DESTINATION } from './permit-types';
import { chainIdToHex, normalizeAddressField, normalizeBytes32, normalizeUint256 } from './witness-values';

/**
 * The Permit2 contract, deployed at the same address on all supported EVM chains; the EIP-712
 * domain verifyingContract for PermitWitnessTransferFrom.
 */
export const PERMIT2_CONTRACT_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/** Hash a PermitWitnessTransferFrom prehash (or one parsed from JSON) into its EIP-712 digest. */
export function hashPermitWitnessTransferFrom(prehash: {
  domain: any;
  types: any;
  message: any;
}): string {
  return TypedDataEncoder.hash(prehash.domain, prehash.types, prehash.message);
}

/**
 * Byte cap the escrow puts on the committed `destination` (MAX_DESTINATION_BYTES in
 * ../../../source/src/Escrow.sol), uniform across EVM, TVM and SVM. witness-typehash.test.ts reads
 * the contract's declaration and fails if the two disagree.
 */
export const MAX_DESTINATION_BYTES = 256;

/** Refuses a destination the escrow would revert on, measured in UTF-8 bytes as Solidity does. */
export function assertDestinationWithinBounds(destination: string): void {
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

/** Parameters for a deposit prehash with the four-member DepositWitness. */
export interface PermitWitnessTransferFromWithDestinationParams {
  /** EIP-155 chain ID. */
  chainId: number;
  /** The Permit2 contract (PERMIT2_CONTRACT_ADDRESS). */
  verifyingContract: string;

  /** TokenPermissions: source token and the permit cap (not the actual charge). */
  token: string;
  amount: bigint | string;

  /** The escrow contract address (spender). */
  spender: string;
  nonce: bigint | string;
  deadline: bigint | string;

  /** DepositWitness: the depositor's commitment to the deposit request. */
  depositRequestHash: string;
  /**
   * DepositWitness: the plaintext payee, hashed byte for byte as keccak256(bytes(destination)).
   * Compose it with the shared destination builder; no normalization is applied here.
   */
  destination: string;
  /** DepositWitness: quote selector authorized to sign the ReserveWitness. */
  reserver: string;
  /** DepositWitness: fulfillment verifier authorized to release or refund. */
  releaser: string;
}

/**
 * Build the Permit2 prehash for the four-member DepositWitness, shaped for
 * `wallet.signTypedData(domain, types, message)`: `types` carries no EIP712Domain entry (ethers
 * derives it), `domain` carries only Permit2's fields (name, chainId, verifyingContract), `chainId`
 * is a lowercase hex string, and the top-level key order is types, primaryType, domain, message.
 *
 * Counterpart of the Go encoder's `BuildTypedDataWithDestination`.
 *
 * @throws if `destination` is empty or longer than MAX_DESTINATION_BYTES in UTF-8 bytes; the
 * escrow reverts on both.
 */
export function createPermitWitnessTransferFromPrehashWithDestination(
  params: PermitWitnessTransferFromWithDestinationParams,
) {
  assertDestinationWithinBounds(params.destination);
  return {
    types: PERMIT_WITNESS_TYPES_WITH_DESTINATION,
    primaryType: 'PermitWitnessTransferFrom',
    domain: {
      name: 'Permit2',
      chainId: chainIdToHex(params.chainId),
      verifyingContract: normalizeAddressField('verifyingContract', params.verifyingContract),
    },
    message: {
      permitted: {
        token: normalizeAddressField('token', params.token),
        amount: normalizeUint256('amount', params.amount),
      },
      spender: normalizeAddressField('spender', params.spender),
      nonce: normalizeUint256('nonce', params.nonce),
      deadline: normalizeUint256('deadline', params.deadline),
      witness: {
        depositRequestHash: normalizeBytes32('depositRequestHash', params.depositRequestHash),
        destination: params.destination,
        reserver: normalizeAddressField('reserver', params.reserver),
        releaser: normalizeAddressField('releaser', params.releaser),
      },
    },
  };
}
