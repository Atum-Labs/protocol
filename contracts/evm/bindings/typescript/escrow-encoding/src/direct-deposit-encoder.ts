/**
 * Encoders for the originator-executed direct deposit path: the
 * `directDeposit` and `reserve` calldata, the three-call funding batch, the deposit id, the
 * active-deposit hashes both states of a direct deposit store, and the `DepositReserved` overlay.
 *
 * Byte-for-byte counterpart of the Go encoder (go/escrow-encoding/encoding/direct_deposit_encoder.go).
 * Both assert their output against conformance/direct-deposit-vectors.json, which
 * source/test/Escrow.directDepositVectors.t.sol binds to the real contract.
 */

import {
  AbiCoder,
  Interface,
  type InterfaceAbi,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  toUtf8Bytes,
  ZeroAddress,
  ZeroHash,
} from 'ethers';
import { assertDestinationWithinBounds } from './deposit-encoder';
import { normalizeAddressField, normalizeBytes32, normalizeUint256 } from './witness-values';

/** DIRECT_DEPOSIT_DOMAIN_TAG, keccak256("Escrow:directDeposit:v1"): the first word of the id preimage. */
export const DIRECT_DEPOSIT_DOMAIN_TAG = keccak256(toUtf8Bytes('Escrow:directDeposit:v1'));

/** DEPOSIT_WITNESS_TYPE_HASH, the EIP-712 type hash of the DepositWitness. */
export const DEPOSIT_WITNESS_TYPE_HASH = keccak256(
  toUtf8Bytes(
    'DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)',
  ),
);

/** The 4-byte selector of reserve(ReserveInput). */
export const RESERVE_SELECTOR = '0xb4b6913b';

const MAX_UINT256 = (1n << 256n) - 1n;
const coder = AbiCoder.defaultAbiCoder();

/**
 * The three fragments this module encodes and decodes: `directDeposit`, `reserve` and the
 * `DepositReserved` event. Only these, not the full generated ABI (about 72 KB, the fulfillment
 * proxy's included): importing the full ABI would make every importer of the package root inline
 * and parse it. direct-deposit-encoder.test.ts ties each fragment to the compiler-emitted ABI at
 * contracts/evm/source/generated/abi/Escrow.json, `internalType` aside, so they cannot drift.
 */
export const DIRECT_DEPOSIT_ABI = [
  {
    type: 'function',
    name: 'directDeposit',
    inputs: [
      {
        name: 'input',
        type: 'tuple',
        components: [
          {
            name: 'token',
            type: 'address',
          },
          {
            name: 'amount',
            type: 'uint256',
          },
          {
            name: 'nonce',
            type: 'uint256',
          },
          {
            name: 'depositWitness',
            type: 'tuple',
            components: [
              {
                name: 'depositRequestHash',
                type: 'bytes32',
              },
              {
                name: 'destination',
                type: 'string',
              },
              {
                name: 'reserver',
                type: 'address',
              },
              {
                name: 'releaser',
                type: 'address',
              },
            ],
          },
        ],
      },
    ],
    outputs: [
      {
        name: 'depositId',
        type: 'bytes32',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'reserve',
    inputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          {
            name: 'depositor',
            type: 'address',
          },
          {
            name: 'token',
            type: 'address',
          },
          {
            name: 'amount',
            type: 'uint256',
          },
          {
            name: 'depositWitness',
            type: 'tuple',
            components: [
              {
                name: 'depositRequestHash',
                type: 'bytes32',
              },
              {
                name: 'destination',
                type: 'string',
              },
              {
                name: 'reserver',
                type: 'address',
              },
              {
                name: 'releaser',
                type: 'address',
              },
            ],
          },
          {
            name: 'reserveWitness',
            type: 'tuple',
            components: [
              {
                name: 'depositId',
                type: 'bytes32',
              },
              {
                name: 'quoteHash',
                type: 'bytes32',
              },
              {
                name: 'settler',
                type: 'address',
              },
              {
                name: 'sourceAmount',
                type: 'uint256',
              },
            ],
          },
          {
            name: 'reserveSignature',
            type: 'bytes',
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'DepositReserved',
    inputs: [
      {
        name: 'depositId',
        type: 'bytes32',
        indexed: true,
      },
      {
        name: 'quoteHash',
        type: 'bytes32',
        indexed: false,
      },
      {
        name: 'settler',
        type: 'address',
        indexed: false,
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'feeAmount',
        type: 'uint256',
        indexed: false,
      },
    ],
    anonymous: false,
  },
] as const;

// Built on first use, so importing the package root does no parsing.
let cachedEscrowInterface: Interface | undefined;
function escrowInterface(): Interface {
  if (!cachedEscrowInterface) {
    cachedEscrowInterface = new Interface(DIRECT_DEPOSIT_ABI as unknown as InterfaceAbi);
  }
  return cachedEscrowInterface;
}
const erc20Interface = new Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

/** IEscrow.DepositWitness. */
export interface DepositWitness {
  depositRequestHash: string;
  /** Plaintext payee; hashed as keccak256(bytes(destination)). */
  destination: string;
  reserver: string;
  releaser: string;
}

/** IEscrow.DirectDepositInput. `amount` is the request's max_source_amount, fees included. */
export interface DirectDepositInput {
  token: string;
  amount: bigint | string;
  nonce: bigint | string;
  depositWitness: DepositWitness;
}

/** IEscrow.ReserveWitness: the reserver signs it, and `sourceAmount` is the charge. */
export interface ReserveWitness {
  depositId: string;
  quoteHash: string;
  settler: string;
  sourceAmount: bigint | string;
}

/** IEscrow.ReserveInput. */
export interface ReserveInput {
  depositor: string;
  token: string;
  amount: bigint | string;
  depositWitness: DepositWitness;
  reserveWitness: ReserveWitness;
  reserveSignature: string;
}

/** One transaction of a batch. Value is always zero. */
export interface Call {
  to: string;
  data: string;
}

/** IEscrow.ActiveDeposit, the tuple the escrow stores a hash of under the deposit id. */
export interface ActiveDeposit {
  depositor: string;
  quoteHash: string;
  depositRequestHash: string;
  destinationHash: string;
  token: string;
  amount: bigint;
  feeAmount: bigint;
  reserver: string;
  releaser: string;
  settler: string;
}

/** The decoded DepositReserved event. */
export interface DepositReserved {
  depositId: string;
  quoteHash: string;
  settler: string;
  amount: bigint;
  feeAmount: bigint;
}

function uint256(label: string, value: bigint | string): bigint {
  const n = BigInt(normalizeUint256(label, value));
  if (n > MAX_UINT256) {
    throw new Error(`${label} does not fit in a uint256`);
  }
  return n;
}

function positiveUint256(label: string, value: bigint | string): bigint {
  const n = uint256(label, value);
  if (n === 0n) {
    throw new Error(`${label} must be greater than zero`);
  }
  return n;
}

function nonZeroAddress(label: string, value: string): string {
  const address = normalizeAddressField(label, value);
  if (address === ZeroAddress) {
    throw new Error(`${label} is the zero address`);
  }
  return address;
}

/** Mirrors Escrow._requireDepositWitness: a witness it rejects makes directDeposit revert. */
function validatedWitness(witness: DepositWitness): DepositWitness {
  const depositRequestHash = normalizeBytes32('depositRequestHash', witness.depositRequestHash);
  if (depositRequestHash === ZeroHash) {
    throw new Error('depositRequestHash is empty');
  }
  assertDestinationWithinBounds(witness.destination);
  return {
    depositRequestHash,
    destination: witness.destination,
    reserver: nonZeroAddress('reserver', witness.reserver),
    releaser: nonZeroAddress('releaser', witness.releaser),
  };
}

/** keccak256 of the destination bytes: the destinationHash the escrow stores. */
export function destinationHash(destination: string): string {
  return keccak256(toUtf8Bytes(destination));
}

/** The EIP-712 struct hash of the DepositWitness, as Escrow._depositWitnessHash computes it. */
export function computeDepositWitnessHash(witness: DepositWitness): string {
  return keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'bytes32', 'address', 'address'],
      [
        DEPOSIT_WITNESS_TYPE_HASH,
        normalizeBytes32('depositRequestHash', witness.depositRequestHash),
        destinationHash(witness.destination),
        normalizeAddressField('reserver', witness.reserver),
        normalizeAddressField('releaser', witness.releaser),
      ],
    ),
  );
}

export interface DirectDepositIdParams {
  chainId: bigint | number;
  escrow: string;
  /** The account that calls directDeposit, the depositor. */
  owner: string;
  token: string;
  nonce: bigint | string;
  depositWitness: DepositWitness;
  /** The deposited maximum (the request's max_source_amount). */
  amount: bigint | string;
}

/**
 * The deposit id of a direct deposit:
 * keccak256(abi.encode(DIRECT_DEPOSIT_DOMAIN_TAG, chainid, escrow, owner, token, nonce,
 * depositWitnessHash, amount)). The token, nonce, amount and witness are validated like the contract
 * does (a zero token, a zero amount or a witness `directDeposit` rejects would revert), so an id is
 * only returned for a deposit the escrow would accept. `chainId`, `escrow` and `owner` are checked
 * for form only: the contract takes them from block.chainid, its own address and msg.sender.
 */
export function computeDirectDepositId(params: DirectDepositIdParams): string {
  const witness = validatedWitness(params.depositWitness);
  return keccak256(
    coder.encode(
      ['bytes32', 'uint256', 'address', 'address', 'address', 'uint256', 'bytes32', 'uint256'],
      [
        DIRECT_DEPOSIT_DOMAIN_TAG,
        uint256('chainId', BigInt(params.chainId)),
        normalizeAddressField('escrow', params.escrow),
        normalizeAddressField('owner', params.owner),
        nonZeroAddress('token', params.token),
        uint256('nonce', params.nonce),
        computeDepositWitnessHash(witness),
        positiveUint256('amount', params.amount),
      ],
    ),
  );
}

function witnessTuple(witness: DepositWitness) {
  return {
    depositRequestHash: witness.depositRequestHash,
    destination: witness.destination,
    reserver: witness.reserver,
    releaser: witness.releaser,
  };
}

/** The calldata of escrow.directDeposit(input). `input.amount` is the request's max_source_amount. */
export function encodeDirectDepositCalldata(input: DirectDepositInput): string {
  const witness = validatedWitness(input.depositWitness);
  return escrowInterface().encodeFunctionData('directDeposit', [
    {
      token: nonZeroAddress('token', input.token),
      amount: positiveUint256('amount', input.amount),
      nonce: uint256('nonce', input.nonce),
      depositWitness: witnessTuple(witness),
    },
  ]);
}

/**
 * The calldata of escrow.reserve(input), selector 0xb4b6913b. There is no nonce and no deposit id
 * outside the reserve witness. The bounds checked are the ones reserve() reverts on without chain
 * state: a zero settler or quote, a zero charge, a charge above the deposit.
 */
export function encodeReserveCalldata(input: ReserveInput): string {
  const witness = validatedWitness(input.depositWitness);
  const amount = positiveUint256('amount', input.amount);
  const rw = input.reserveWitness;
  const quoteHash = normalizeBytes32('quoteHash', rw.quoteHash);
  if (quoteHash === ZeroHash) {
    throw new Error('reserve witness quoteHash is empty');
  }
  const sourceAmount = positiveUint256('sourceAmount', rw.sourceAmount);
  if (sourceAmount > amount) {
    throw new Error(
      `reserve witness sourceAmount ${sourceAmount} exceeds the deposited amount ${amount}`,
    );
  }
  const data = escrowInterface().encodeFunctionData('reserve', [
    {
      depositor: nonZeroAddress('depositor', input.depositor),
      token: nonZeroAddress('token', input.token),
      amount,
      depositWitness: witnessTuple(witness),
      reserveWitness: {
        depositId: normalizeBytes32('depositId', rw.depositId),
        quoteHash,
        settler: nonZeroAddress('settler', rw.settler),
        sourceAmount,
      },
      reserveSignature: hexlify(getBytes(input.reserveSignature)),
    },
  ]);
  if (data.slice(0, 10) !== RESERVE_SELECTOR) {
    throw new Error(
      `reserve selector is ${data.slice(0, 10)}, expected ${RESERVE_SELECTOR}: the ABI drifted`,
    );
  }
  return data;
}

/**
 * The three calls the owner account sends, in order:
 * token.approve(escrow, 0), token.approve(escrow, amount), escrow.directDeposit(input).
 *
 * The reset to zero is what makes a Tempo access key's spending limit charge exactly `amount` (the
 * limit is charged on the key's own approve, not on the escrow's transferFrom); it is the signer's
 * discipline and the contract does not check it.
 */
export function buildDirectDepositFundingBatch(escrow: string, input: DirectDepositInput): Call[] {
  const escrowAddress = normalizeAddressField('escrow', escrow);
  const deposit = encodeDirectDepositCalldata(input);
  const token = nonZeroAddress('token', input.token);
  const amount = positiveUint256('amount', input.amount);
  return [
    { to: token, data: erc20Interface.encodeFunctionData('approve', [escrowAddress, 0n]) },
    { to: token, data: erc20Interface.encodeFunctionData('approve', [escrowAddress, amount]) },
    { to: escrowAddress, data: deposit },
  ];
}

/** keccak256(abi.encode(activeDeposit)): ten static words, in declaration order. */
export function computeActiveDepositHash(deposit: ActiveDeposit): string {
  return keccak256(
    coder.encode(
      [
        'address',
        'bytes32',
        'bytes32',
        'bytes32',
        'address',
        'uint256',
        'uint256',
        'address',
        'address',
        'address',
      ],
      [
        normalizeAddressField('depositor', deposit.depositor),
        normalizeBytes32('quoteHash', deposit.quoteHash),
        normalizeBytes32('depositRequestHash', deposit.depositRequestHash),
        normalizeBytes32('destinationHash', deposit.destinationHash),
        normalizeAddressField('token', deposit.token),
        uint256('amount', deposit.amount),
        uint256('feeAmount', deposit.feeAmount),
        normalizeAddressField('reserver', deposit.reserver),
        normalizeAddressField('releaser', deposit.releaser),
        normalizeAddressField('settler', deposit.settler),
      ],
    ),
  );
}

/**
 * The tuple directDeposit stores: zero quoteHash, settler and feeAmount, and amount = the deposited
 * maximum. `depositor` is the account that called directDeposit.
 */
export function unreservedActiveDeposit(params: {
  depositor: string;
  token: string;
  amount: bigint | string;
  depositWitness: DepositWitness;
}): ActiveDeposit {
  const witness = validatedWitness(params.depositWitness);
  return {
    depositor: normalizeAddressField('depositor', params.depositor),
    quoteHash: ZeroHash,
    depositRequestHash: witness.depositRequestHash,
    destinationHash: destinationHash(witness.destination),
    token: normalizeAddressField('token', params.token),
    amount: positiveUint256('amount', params.amount),
    feeAmount: 0n,
    reserver: witness.reserver,
    releaser: witness.releaser,
    settler: ZeroAddress,
  };
}

/**
 * The tuple reserve() rewrites the stored hash to: the unreserved tuple with the winning quoteHash
 * and settler, amount = sourceAmount (what the quote charged) and the fee on it. The fee is
 * computed on chain from the token config locked at deposit time, so take it from DepositReserved rather
 * than recomputing it.
 */
export function reservedActiveDeposit(
  unreserved: ActiveDeposit,
  reserve: {
    quoteHash: string;
    settler: string;
    sourceAmount: bigint | string;
    feeAmount: bigint | string;
  },
): ActiveDeposit {
  const sourceAmount = positiveUint256('sourceAmount', reserve.sourceAmount);
  if (sourceAmount > unreserved.amount) {
    throw new Error(
      `sourceAmount ${sourceAmount} exceeds the deposited amount ${unreserved.amount}`,
    );
  }
  return {
    ...unreserved,
    quoteHash: normalizeBytes32('quoteHash', reserve.quoteHash),
    settler: normalizeAddressField('settler', reserve.settler),
    amount: sourceAmount,
    feeAmount: uint256('feeAmount', reserve.feeAmount),
  };
}

/**
 * Decodes a DepositReserved log: event DepositReserved(bytes32 indexed depositId, bytes32 quoteHash,
 * address settler, uint256 amount, uint256 feeAmount). Checks the log's own shape only; the caller
 * filters by emitter, the escrow address.
 */
export function decodeDepositReservedLog(log: {
  topics: readonly string[];
  data: string;
}): DepositReserved {
  const event = escrowInterface().getEvent('DepositReserved');
  if (!event) {
    throw new Error('Escrow ABI has no DepositReserved event');
  }
  if (log.topics.length !== 2 || log.topics[0]?.toLowerCase() !== event.topicHash) {
    throw new Error('log is not a DepositReserved event');
  }
  const parsed = escrowInterface().parseLog({ topics: [...log.topics], data: log.data });
  if (!parsed) {
    throw new Error('log is not a DepositReserved event');
  }
  return {
    depositId: normalizeBytes32('depositId', parsed.args.depositId),
    quoteHash: normalizeBytes32('quoteHash', parsed.args.quoteHash),
    settler: getAddress(parsed.args.settler),
    amount: parsed.args.amount as bigint,
    feeAmount: parsed.args.feeAmount as bigint,
  };
}

/**
 * Overlays the four values DepositReserved carries on the deposit-time tuple. Refuses an overlay
 * for another deposit's id or one that charges more than the deposited amount.
 */
export function applyDepositReserved(
  depositId: string,
  unreserved: ActiveDeposit,
  event: DepositReserved,
): ActiveDeposit {
  if (normalizeBytes32('depositId', depositId) !== event.depositId) {
    throw new Error(`DepositReserved is for deposit ${event.depositId}, not ${depositId}`);
  }
  return reservedActiveDeposit(unreserved, {
    quoteHash: event.quoteHash,
    settler: event.settler,
    sourceAmount: event.amount,
    feeAmount: event.feeAmount,
  });
}
