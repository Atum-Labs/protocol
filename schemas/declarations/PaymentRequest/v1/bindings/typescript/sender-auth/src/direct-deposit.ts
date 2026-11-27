import {
  computeActiveDepositHash,
  computeDirectDepositId,
  unreservedActiveDeposit,
  type ActiveDeposit,
  type DepositWitness,
} from '@atum-labs/evm-escrow-encoding';
import { getAddress } from 'ethers';

import {
  EXECUTOR_ORIGINATOR,
  EXECUTOR_SETTLER,
  readAmount,
  readDepositRequest,
} from './deposit-request-v2.js';

/**
 * The depositRequestHash an originator-executed deposit's witness commits: 1 is
 * keccak256(request_id), 2 commits the payment terms. The payer picks it when it funds the deposit,
 * and the escrow treats the hash as opaque, so every reader of the deposit is told which one it
 * is: there is no default. Mirrors the Go `DirectDepositHashVersion`.
 */
export type DirectDepositHashVersion = 1 | 2;

/** The reasons a `DirectDepositError` reports: a bounded set, for metric tags. */
export type DirectDepositReason =
  | 'request'
  | 'executor'
  | 'deposit_nonce'
  | 'version'
  | 'sender_auth'
  | 'source'
  | 'escrow'
  | 'quote_selector'
  | 'fulfillment_verifier'
  | 'max_source_amount';

/** A request `deriveDirectDeposit` cannot name a deposit from. Mirrors the Go `DirectDepositError`. */
export class DirectDepositError extends Error {
  readonly reason: DirectDepositReason;
  readonly detail: string;

  constructor(reason: DirectDepositReason, detail: string) {
    super(`direct deposit: ${reason}: ${detail}`);
    this.name = 'DirectDepositError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** What the payer passes to directDeposit. Calling it with these values lands the deposit under the id. */
export interface DerivedDirectDepositInput {
  token: string;
  amount: bigint;
  nonce: bigint;
  depositWitness: DepositWitness;
}

/** The deposit an originator-executed PaymentRequest names. Mirrors the Go `DirectDeposit`. */
export interface DirectDeposit {
  /** The deposit id, the escrow's key for the deposit and the payment's id. */
  depositId: string;
  input: DerivedDirectDepositInput;
  /** The tuple directDeposit stored, and its hash: what getDepositHash(depositId) returns until reserved. */
  unreserved: ActiveDeposit;
  unreservedHash: string;
}

/** A CAIP-19 ERC-20 on an EVM chain, the only source directDeposit pulls. */
const EVM_TOKEN_ASSET = /^eip155:([0-9]+)\/erc20:(0x[0-9a-fA-F]{40})$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function refuse(reason: DirectDepositReason, detail: string): never {
  throw new DirectDepositError(reason, detail);
}

/**
 * Derives the deposit an originator-executed PaymentRequest names, from the request exactly as
 * received, the source chain id and escrow the deposit was made on, and the depositRequestHash
 * version its witness commits. The payer, payment-gw, the settler and veri-fill all derive it here,
 * so none of them re-implements the preimage. Mirrors the Go `DeriveDirectDeposit`, check for
 * check: both are pinned to conformance/direct-deposit-derivation-vectors.json.
 *
 * Throws `DirectDepositError` for a request that cannot name a deposit.
 */
export function deriveDirectDeposit(
  requestJson: string,
  chainId: bigint,
  escrow: string,
  version: DirectDepositHashVersion,
): DirectDeposit {
  if (version !== 1 && version !== 2)
    refuse('version', `unknown depositRequestHash version ${String(version)}`);
  let read: ReturnType<typeof readDepositRequest>;
  try {
    read = readDepositRequest(requestJson);
  } catch (err) {
    return refuse('request', (err as Error).message);
  }
  const { terms } = read;
  if (terms.executor.deposit !== EXECUTOR_ORIGINATOR)
    refuse('executor', 'the deposit leg is not originator-executed');
  // The settler submits reserve(), as the Validate rules require: an id for any other request would
  // name a deposit payment-gw refuses.
  if (terms.executor.reserve !== EXECUTOR_SETTLER)
    refuse('executor', 'an originator-executed deposit is reserved by the settler');
  // The reader refused a case twin of any root member, so an own-property lookup sees the one
  // sender_auth there is. null counts as present: the settler refuses it too.
  const root = JSON.parse(requestJson) as Record<string, unknown>;
  if (Object.hasOwn(root, 'sender_auth'))
    refuse('sender_auth', 'an originator-executed deposit carries no sender_auth');
  if (read.depositNonce === undefined) refuse('deposit_nonce', 'deposit_nonce is missing');
  const nonceText = readAmount(read.depositNonce, 'deposit_nonce');
  if (typeof nonceText !== 'string') refuse('deposit_nonce', nonceText.detail);
  const nonce = BigInt(nonceText);
  const source = EVM_TOKEN_ASSET.exec(terms.sourceAssetIdentifier);
  if (source === null) refuse('source', 'source.asset_identifier is not an ERC-20 on an EVM chain');
  if (source[1] !== chainId.toString())
    refuse('source', `the source is on chain ${source[1]}, not ${chainId.toString()}`);
  if (!HEX_ADDRESS.test(terms.sourceAccount)) refuse('source', 'source.account is not an address');
  if (!HEX_ADDRESS.test(escrow) || BigInt(escrow) === 0n)
    refuse('escrow', 'the escrow is not a nonzero address');
  if (terms.escrowContractAddress.toLowerCase() !== escrow.toLowerCase())
    refuse('escrow', 'escrow_contract_address is not the escrow the deposit was made on');
  // The escrow refuses a zero reserver or releaser, as the Validate rules do.
  if (terms.quoteSelector === undefined || !HEX_ADDRESS.test(terms.quoteSelector))
    refuse('quote_selector', 'quote_selector is not an address');
  if (BigInt(terms.quoteSelector) === 0n)
    refuse('quote_selector', 'quote_selector is the zero address');
  if (!HEX_ADDRESS.test(terms.fulfillmentVerifierAccount))
    refuse('fulfillment_verifier', 'fulfillment_verifier.account is not an address');
  if (BigInt(terms.fulfillmentVerifierAccount) === 0n)
    refuse('fulfillment_verifier', 'fulfillment_verifier.account is the zero address');
  // The reader has already bounded max_source_amount to uint256 and stripped its leading zeros.
  if (terms.maxSourceAmount === undefined || terms.maxSourceAmount === '0')
    refuse('max_source_amount', 'max_source_amount is missing or zero');
  const amount = BigInt(terms.maxSourceAmount);

  // Addresses are read case-insensitively, as Go and the escrow do: lowercased first, so a wrong
  // EIP-55 checksum on a mixed-case address does not throw.
  const token = getAddress(source[2].toLowerCase());
  const owner = getAddress(terms.sourceAccount.toLowerCase());
  const depositWitness: DepositWitness = {
    depositRequestHash: version === 1 ? read.depositRequestHashV1 : read.depositRequestHashV2,
    destination: terms.destination,
    reserver: getAddress(terms.quoteSelector.toLowerCase()),
    releaser: getAddress(terms.fulfillmentVerifierAccount.toLowerCase()),
  };
  try {
    const depositId = computeDirectDepositId({
      chainId,
      escrow: escrow.toLowerCase(),
      owner,
      token,
      nonce,
      depositWitness,
      amount,
    });
    const unreserved = unreservedActiveDeposit({ depositor: owner, token, amount, depositWitness });
    return {
      depositId,
      input: { token, amount, nonce, depositWitness },
      unreserved,
      unreservedHash: computeActiveDepositHash(unreserved),
    };
  } catch (err) {
    return refuse('request', (err as Error).message);
  }
}
