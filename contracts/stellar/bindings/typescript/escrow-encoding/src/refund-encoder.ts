import { EscrowDomain } from './escrow-domain';
import { EscrowSettlementParams, settlementHash } from './release-encoder';

/** The same eleven-member witness as a release. */
export type EscrowRefundParams = EscrowSettlementParams;

/**
 * Computes the refund digest.
 *
 * This digest is signed by the releaser to return the full `amount` to the depositor; the fee is only
 * taken on release.
 *
 * Hash formula (Rust source: `compute_refund_hash`, 400 bytes): the release layout with tag "refund":
 *
 *   keccak256(
 *     "escrow" || version[1] || network_id[32] || contract_id[32] ||
 *     "refund" || deposit_id[32] || quote_hash[32] || deposit_request_hash[32] || destination_hash[32] ||
 *     depositor[33] || token[33] || amount[16,LE] || fee_amount[16,LE] ||
 *     reserver[32] || releaser[32] || settler[33]
 *   )
 */
export function computeRefundHash(params: EscrowRefundParams, domain: EscrowDomain): Uint8Array {
  return settlementHash(params, 'refund', domain);
}
