import { Address } from './address';
import {
  encodeAmount16,
  encodeU64LE,
  isZeroBytes32,
  keccak256,
  requireBytes32,
  stringToBytes,
} from './encoding-utils';
import { EscrowDomain, hashWithDomain } from './escrow-domain';
import {
  DeadlineTooFarInFutureError,
  DestinationTooLongError,
  EmptyDestinationError,
  InvalidDestinationError,
  InconsistentTimestampsError,
  ZeroAmountError,
  ZeroDepositRequestHashError,
  ZeroReleaserError,
  ZeroReserverError,
} from './errors';
import { Pubkey } from './pubkey';

/**
 * Maximum byte length of the committed destination (`MAX_DESTINATION_BYTES`).
 *
 * 256 is uniform across EVM, TVM and SVM so one client signing-policy rule covers every chain.
 */
export const MAX_DESTINATION_LEN = 256;

/**
 * Bounds deadline - issued_at (`MAX_DEPOSIT_VALIDITY_SECS`): 24 hours. Only the span is checkable offline;
 * the contract also compares both ends to the ledger close time, which the caller must read from the
 * latest closed ledger, not the local clock.
 */
export const MAX_DEPOSIT_VALIDITY_SECS = 86400n;

/**
 * Parameters needed to compute the deposit digest.
 */
export interface EscrowDepositParams {
  /**
   * The commitment to the offchain deposit request. Its derivation is defined by the offchain protocol
   * layer; the contract only requires it to be non-zero.
   */
  depositRequestHash: Uint8Array;
  /**
   * The plaintext `<CAIP-19 asset>@<account>` the payer commits to, 1 to {@link MAX_DESTINATION_LEN}
   * UTF-8 bytes. Committed as keccak256(destination), never fed raw.
   */
  destination: string;
  /** The account whose SEP-41 allowance funds the deposit. It does not sign the digest. */
  depositor: Address;
  /** The SEP-41 token contract. */
  token: Address;
  /**
   * The epoch of the delegate record that authorises the deposit (`get_delegate(...).epoch`, or the value
   * `create_delegate` returned, which `DelegateCreated.epoch` also carries): 1 for the first record of the (depositor, token), +1 for each re-creation,
   * kept across revokes. It binds the signature to one record, so a deposit signed before a revoke stays
   * dead when the same signer key is enrolled again.
   */
  epoch: bigint;
  /**
   * The ceiling the depositor authorises (`DepositInput.amount`), not the charge: the delegate signs it
   * before the auction, so it commits to the ceiling.
   */
  amount: bigint;
  /** The raw ed25519 key that signs the reserve digest. */
  reserver: Pubkey;
  /** The raw ed25519 key that signs the release and refund digests. */
  releaser: Pubkey;
  /** Unordered and per depositor; it can never be reused. */
  nonce: bigint;
  /** Seconds. The contract requires it to be <= ledger time. */
  issuedAt: bigint;
  /** Seconds. The contract requires it to be >= ledger time and <= issuedAt + 86400. */
  deadline: bigint;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isWellFormed(s: string): boolean {
  return !LONE_SURROGATE.test(s);
}

/**
 * keccak256 of the destination's UTF-8 bytes.
 *
 * The single place the destination becomes bytes for hashing, mirroring the contract's
 * `destination_hash`, and identical to EVM, TVM and SVM for the same string. Keeping it separate is what
 * makes the hash-first rule enforceable rather than conventional: computeDepositHash never concatenates a
 * string.
 */
export function computeDestinationHash(destination: string): Uint8Array {
  return keccak256(stringToBytes(destination));
}

/**
 * Computes the deposit digest, which is also the deposit id.
 *
 * This digest is signed once, before the auction, by the depositor's delegate signer (ed25519 over the 32
 * digest bytes, no prefix or framing). It is the id every later reserve, release and refund names.
 *
 * Hash formula (Rust source: `compute_deposit_hash`, 320 bytes):
 *
 *   keccak256(
 *     "escrow" || version[1] || network_id[32] || contract_id[32] ||
 *     "deposit" || deposit_request_hash[32] || destination_hash[32] || depositor[33] || token[33] || epoch[8,LE] ||
 *     amount[16,LE] || reserver[32] || releaser[32] ||
 *     nonce[8,LE] || issued_at[8,LE] || deadline[8,LE]
 *   )
 *
 * The guards run in the contract's order. The ledger-time ones (issued_at and deadline against the latest
 * closed ledger's close time) cannot be checked offline and stay the caller's job.
 */
export function computeDepositHash(params: EscrowDepositParams, domain: EscrowDomain): Uint8Array {
  if (params.reserver.isZero()) throw new ZeroReserverError();
  if (params.releaser.isZero()) throw new ZeroReleaserError();
  requireBytes32('depositRequestHash', params.depositRequestHash);
  if (isZeroBytes32(params.depositRequestHash)) throw new ZeroDepositRequestHashError();
  if (params.destination.length === 0) throw new EmptyDestinationError();
  // TextEncoder would silently turn a lone surrogate into U+FFFD, hashing bytes the caller never
  // wrote. Go rejects invalid UTF-8 for the same reason, so the two agree on what is hashable.
  if (!isWellFormed(params.destination)) throw new InvalidDestinationError();
  // Byte length, not UTF-16 code units: the contract bounds the UTF-8 encoding, so a multi-byte
  // destination must be measured the same way here or the two sides disagree at the limit.
  if (stringToBytes(params.destination).length > MAX_DESTINATION_LEN) {
    throw new DestinationTooLongError();
  }
  const amount = encodeAmount16(params.amount);
  if (params.amount === 0n) throw new ZeroAmountError();
  if (params.issuedAt > params.deadline) throw new InconsistentTimestampsError();
  if (params.deadline - params.issuedAt > MAX_DEPOSIT_VALIDITY_SECS) {
    throw new DeadlineTooFarInFutureError();
  }

  return hashWithDomain(
    domain,
    'deposit',
    params.depositRequestHash,
    // Hash first: keccak256 concatenates without length prefixes, so injectivity depends on every
    // hashed field being fixed-width. Feeding the raw string would make it conditional on the
    // surrounding widths and diverge from the contract, which hashes it too.
    computeDestinationHash(params.destination),
    params.depositor.toBytes33(),
    params.token.toBytes33(),
    encodeU64LE(params.epoch),
    amount,
    params.reserver.toBytes(),
    params.releaser.toBytes(),
    encodeU64LE(params.nonce),
    encodeU64LE(params.issuedAt),
    encodeU64LE(params.deadline),
  );
}
