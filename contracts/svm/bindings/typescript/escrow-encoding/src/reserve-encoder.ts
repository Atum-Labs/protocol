import { Pubkey } from './pubkey';
import { keccak256, stringToBytes, isZeroBytes32, encodeU64LE } from './encoding-utils';
import { EscrowDomain, escrowDomainPrefixBytes } from './escrow-domain';
import {
  ZeroDepositHashError,
  ZeroRecipientError,
  ZeroQuoteHashError,
  ZeroSourceAmountError,
} from './errors';

export interface EscrowReserveParams {
  depositHash: Uint8Array;
  recipient: Pubkey;
}

/**
 * Computes the reserve message hash under the FROZEN pre-quote-hash layout
 * (signature_domain_version 1 and 2). See computeReserveHashV2 below for versions 3 and 4 and
 * computeReserveHashV3 from version 5.
 *
 * Hash formula (the program's layout at domain versions 1 and 2):
 *
 *   keccak256(
 *     "escrow" || version[1] || cluster_id[32] || program_id[32] ||
 *     "reserve" || recipient[32] || deposit_hash[32]
 *   )
 */
export function computeReserveHash(
  params: EscrowReserveParams,
  domain: EscrowDomain,
): Uint8Array {
  if (params.depositHash.length !== 32 || isZeroBytes32(params.depositHash)) {
    throw new ZeroDepositHashError();
  }
  if (params.recipient.isZero()) throw new ZeroRecipientError();

  return keccak256(
    ...escrowDomainPrefixBytes(domain),
    stringToBytes('reserve'),
    params.recipient.toBytes(),
    params.depositHash,
  );
}

/**
 * Computes the signature_domain_version 3 and 4 reserve message hash, which binds the offchain
 * quote hash. From version 5 use computeReserveHashV3.
 *
 * Hash formula (the program's layout at domain versions 3 and 4):
 *
 *   keccak256(
 *     "escrow" || version[1] || cluster_id[32] || program_id[32] ||
 *     "reserve" || recipient[32] || deposit_hash[32] || quote_hash[32]
 *   )
 *
 * Additive: {@link computeReserveHash} above is the frozen pre-quote-hash layout that domain versions 1
 * and 2 signed, and is unchanged.
 *
 * quote_hash must be non-zero here: a reserve always follows a quote. Release and refund deliberately
 * permit a zero quote hash, because a deposit can be refunded having never been reserved.
 */
export function computeReserveHashV2(
  params: EscrowReserveParams,
  quoteHash: Uint8Array,
  domain: EscrowDomain,
): Uint8Array {
  if (params.depositHash.length !== 32 || isZeroBytes32(params.depositHash)) {
    throw new ZeroDepositHashError();
  }
  if (params.recipient.isZero()) throw new ZeroRecipientError();
  if (quoteHash.length !== 32 || isZeroBytes32(quoteHash)) throw new ZeroQuoteHashError();

  return keccak256(
    ...escrowDomainPrefixBytes(domain),
    stringToBytes('reserve'),
    params.recipient.toBytes(),
    params.depositHash,
    quoteHash,
  );
}

/**
 * Computes the signature_domain_version 5+ reserve message hash, which additionally binds
 * `sourceAmount` — the amount the payer is ACTUALLY charged.
 *
 * Hash formula (Rust source: `compute_reserve_hash`):
 *
 *   keccak256(
 *     "escrow" || version[1] || cluster_id[32] || program_id[32] ||
 *     "reserve" || recipient[32] || deposit_hash[32] || quote_hash[32] || source_amount[8 LE]
 *   )
 *
 * Additive: {@link computeReserveHash} and {@link computeReserveHashV2} above are unchanged and
 * still document the layouts their domain versions signed.
 *
 * Why the charge belongs in the SIGNED preimage rather than beside it as a bare instruction
 * argument: the depositor signs a ceiling at deposit time, before the auction picks a winner, so
 * the charge can only be stated later. Whoever states it is deciding how much of the payer's
 * authorization to consume, and that has to be the RESERVER (the quote selector) whose key this
 * hash is verified against — otherwise the settler, the party being paid, would choose what the
 * payer is charged, bounded only by the ceiling. EVM has the same property by putting
 * `sourceAmount` inside the reserver-signed ReserveWitness.
 *
 * `sourceAmount` is a bigint, not a number: a u64 above 2^53 loses precision as a JS number, and
 * for this field that means signing one charge and settling another.
 */
export function computeReserveHashV3(
  params: EscrowReserveParams,
  quoteHash: Uint8Array,
  sourceAmount: bigint,
  domain: EscrowDomain,
): Uint8Array {
  if (params.depositHash.length !== 32 || isZeroBytes32(params.depositHash)) {
    throw new ZeroDepositHashError();
  }
  if (params.recipient.isZero()) throw new ZeroRecipientError();
  if (quoteHash.length !== 32 || isZeroBytes32(quoteHash)) throw new ZeroQuoteHashError();
  if (sourceAmount === 0n) throw new ZeroSourceAmountError();

  return keccak256(
    ...escrowDomainPrefixBytes(domain),
    stringToBytes('reserve'),
    params.recipient.toBytes(),
    params.depositHash,
    quoteHash,
    encodeU64LE(sourceAmount),
  );
}
