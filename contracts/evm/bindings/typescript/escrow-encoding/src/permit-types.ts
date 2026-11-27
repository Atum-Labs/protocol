/**
 * EIP-712 / TIP-712 types for the Atum escrow: the Permit2 deposit witness and the escrow's
 * reserve, release and refund witnesses. Shared by EVM (EIP-712) and Tron (TIP-712).
 *
 * Every member name, order and type is asserted against the `*_WITNESS_TYPE_HASH` constants read
 * from contracts/evm/source/src/Escrow.sol by witness-typehash.test.ts. The Go encoders in
 * ../../go/encoding mirror these maps byte for byte.
 */

/**
 * Creates an EIP-712 domain object for Permit2 signing.
 *
 * @param chainId - The chain ID (use maskChainId() for Tron)
 * @param verifyingContract - The Permit2 contract address (EVM hex format)
 */
export function createPermit2Domain(chainId: number, verifyingContract: string) {
  return {
    name: 'Permit2',
    chainId,
    verifyingContract,
  };
}

/**
 * Permit2 PermitWitnessTransferFrom types with the deposit witness: the depositor commits to the
 * deposit request (`depositRequestHash`) and to the payee (`destination`, hashed by EIP-712 as
 * keccak256(bytes(destination)), byte for byte). Escrow.sol hands Permit2 the same witness type
 * string, and witness-typehash.test.ts asserts the two agree.
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
 * ReserveWitness: the reserver attests the winning quote (`quoteHash`) and the actual charge
 * (`sourceAmount`, at most the permit's cap; the deposit moves `sourceAmount`).
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
 * ReleaseWitness: the releaser signs the quote the deposit was filled against and reproduces both
 * depositor commitments. `destinationHash` is keccak256 of the depositor's plaintext `destination`.
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
 * RefundWitness: the twin of the ReleaseWitness, differing only in the struct name, so a release
 * signature cannot refund and a refund signature cannot release.
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
