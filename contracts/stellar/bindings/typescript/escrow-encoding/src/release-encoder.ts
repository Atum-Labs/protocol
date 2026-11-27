import { EscrowActiveDeposit, checkActiveDepositWidths } from './active-deposit';
import { encodeAmount16, isZeroBytes32, requireBytes32 } from './encoding-utils';
import { EscrowDomain, hashWithDomain } from './escrow-domain';
import { ZeroDepositIdError, ZeroQuoteHashError } from './errors';

/**
 * Parameters for a release or refund digest: the deposit id and the eleven-member witness (the id plus
 * the ten stored members), in the EVM ReleaseWitness / RefundWitness order.
 */
export interface EscrowSettlementParams extends EscrowActiveDeposit {
  /** The deposit digest returned by computeDepositHash. */
  depositId: Uint8Array;
}

export type EscrowReleaseParams = EscrowSettlementParams;

/**
 * Shared by release and refund, which differ only in the tag. Unlike Solana, the Soroban release and
 * refund both reject a zero quote hash (QuoteHashCannotBeEmpty).
 */
export function settlementHash(
  params: EscrowSettlementParams,
  tag: 'release' | 'refund',
  domain: EscrowDomain,
): Uint8Array {
  requireBytes32('depositId', params.depositId);
  checkActiveDepositWidths(params);
  if (isZeroBytes32(params.quoteHash)) throw new ZeroQuoteHashError();
  if (isZeroBytes32(params.depositId)) throw new ZeroDepositIdError();

  return hashWithDomain(
    domain,
    tag,
    params.depositId,
    params.quoteHash,
    params.depositRequestHash,
    params.destinationHash,
    params.depositor.toBytes33(),
    params.token.toBytes33(),
    encodeAmount16(params.amount),
    encodeAmount16(params.feeAmount),
    params.reserver.toBytes(),
    params.releaser.toBytes(),
    params.settler.toBytes33(),
  );
}

/**
 * Computes the release digest.
 *
 * This digest is signed by the releaser (member 10, as on EVM; ed25519 over the 32 digest bytes) to pay
 * the settler `amount - fee_amount` and book the fee. Release and refund differ only in the tag, so a
 * release signature can never validate as a refund.
 *
 * Hash formula (Rust source: `compute_release_hash`, 401 bytes):
 *
 *   keccak256(
 *     "escrow" || version[1] || network_id[32] || contract_id[32] ||
 *     "release" || deposit_id[32] || quote_hash[32] || deposit_request_hash[32] || destination_hash[32] ||
 *     depositor[33] || token[33] || amount[16,LE] || fee_amount[16,LE] ||
 *     reserver[32] || releaser[32] || settler[33]
 *   )
 */
export function computeReleaseHash(params: EscrowReleaseParams, domain: EscrowDomain): Uint8Array {
  return settlementHash(params, 'release', domain);
}
