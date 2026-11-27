/**
 * ABI fragments for the Atum Escrow contract (EVM/TVM): the subset needed to deposit and refund.
 *
 * escrow-abi.test.ts asserts every fragment here is structurally identical, through nested tuple
 * components, to the compiler-emitted ABI at contracts/evm/source/generated/abi/Escrow.json. For
 * any other function, event or error, use that file.
 */

/** JSON ABI subset of the Atum Escrow contract (EVM / ethers.js). */
export const ESCROW_V3_ABI_JSON = [
  {
    type: 'function',
    name: 'deposit',
    inputs: [
      {
        name: 'depositInput',
        type: 'tuple',
        components: [
          {
            name: 'permit',
            type: 'tuple',
            components: [
              {
                name: 'permitted',
                type: 'tuple',
                components: [
                  { name: 'token', type: 'address' },
                  { name: 'amount', type: 'uint256' },
                ],
              },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' },
            ],
          },
          { name: 'depositor', type: 'address' },
          {
            name: 'depositWitness',
            type: 'tuple',
            components: [
              { name: 'depositRequestHash', type: 'bytes32' },
              { name: 'destination', type: 'string' },
              { name: 'reserver', type: 'address' },
              { name: 'releaser', type: 'address' },
            ],
          },
          { name: 'depositSignature', type: 'bytes' },
          {
            name: 'reserveWitness',
            type: 'tuple',
            components: [
              { name: 'depositId', type: 'bytes32' },
              { name: 'quoteHash', type: 'bytes32' },
              { name: 'settler', type: 'address' },
              { name: 'sourceAmount', type: 'uint256' },
            ],
          },
          { name: 'reserveSignature', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'depositId', type: 'bytes32' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'refund',
    inputs: [
      {
        name: 'refundInput',
        type: 'tuple',
        components: [
          {
            name: 'refundWitness',
            type: 'tuple',
            components: [
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
          },
          { name: 'refundSignature', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getDepositHash',
    inputs: [{ name: 'depositId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'i_permit2',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const;
