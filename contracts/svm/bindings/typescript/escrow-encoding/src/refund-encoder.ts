import { keccak256, stringToBytes, isZeroBytes32 } from './encoding-utils';
import { EscrowDomain, escrowDomainPrefixBytes } from './escrow-domain';
import { ZeroDepositHashError } from './errors';

export interface EscrowRefundParams {
  depositHash: Uint8Array;
}

/**
 * Computes the refund message hash under the FROZEN pre-quote-hash layout
 * (signature_domain_version 1 and 2). See computeRefundHashV2 below for v3+.
 *
 * Hash formula (the program's layout at domain versions 1 and 2):
 *
 *   keccak256(
 *     "escrow" || version[1] || cluster_id[32] || program_id[32] ||
 *     "refund" || deposit_hash[32]
 *   )
 */
export function computeRefundHash(
  params: EscrowRefundParams,
  domain: EscrowDomain,
): Uint8Array {
  if (params.depositHash.length !== 32 || isZeroBytes32(params.depositHash)) {
    throw new ZeroDepositHashError();
  }

  return keccak256(
    ...escrowDomainPrefixBytes(domain),
    stringToBytes('refund'),
    params.depositHash,
  );
}

/**
 * Computes the signature_domain_version 3+ refund message hash, which binds the offchain quote hash.
 *
 * Hash formula (Rust source: `compute_refund_hash`):
 *
 *   keccak256(
 *     "escrow" || version[1] || cluster_id[32] || program_id[32] ||
 *     "refund" || deposit_hash[32] || quote_hash[32]
 *   )
 *
 * Additive: {@link computeRefundHash} above is the frozen pre-quote-hash layout that domain versions 1
 * and 2 signed, and is unchanged.
 *
 * A zero quote_hash is legitimate and must stay accepted: a deposit can be refunded having never been
 * reserved, in which case no quote was ever bound to it.
 */
export function computeRefundHashV2(
  params: EscrowRefundParams,
  quoteHash: Uint8Array,
  domain: EscrowDomain,
): Uint8Array {
  if (params.depositHash.length !== 32 || isZeroBytes32(params.depositHash)) {
    throw new ZeroDepositHashError();
  }

  return keccak256(
    ...escrowDomainPrefixBytes(domain),
    stringToBytes('refund'),
    params.depositHash,
    quoteHash,
  );
}
