import { Address } from './address';
import { encodeAmount16, isZeroBytes32, requireBytes32 } from './encoding-utils';
import { EscrowDomain, hashWithDomain } from './escrow-domain';
import {
  InvalidSourceAmountError,
  ZeroDepositIdError,
  ZeroQuoteHashError,
  ZeroSourceAmountError,
} from './errors';

export interface EscrowReserveParams {
  /** The deposit digest returned by computeDepositHash. */
  depositId: Uint8Array;
  /** The offchain quote hash the reserver selected. */
  quoteHash: Uint8Array;
  /** The account paid at release, named by the reserver, not the depositor. */
  settler: Address;
  /** The amount actually charged, 0 < sourceAmount <= the deposit's amount. */
  sourceAmount: bigint;
}

/**
 * Enforces `0 < source_amount <= amount`, the contract's rule across the two witnesses.
 * computeReserveHash cannot, because the ceiling is not one of its inputs.
 */
export function checkSourceAmount(ceiling: bigint, sourceAmount: bigint): void {
  encodeAmount16(ceiling);
  encodeAmount16(sourceAmount);
  if (sourceAmount === 0n) throw new ZeroSourceAmountError();
  if (sourceAmount > ceiling) throw new InvalidSourceAmountError();
}

/**
 * Computes the reserve digest.
 *
 * This digest is signed by the reserver (ed25519 over the 32 digest bytes). source_amount is inside the
 * signature so the settler, who is paid, cannot choose what the depositor is charged.
 *
 * Hash formula (Rust source: `compute_reserve_hash`, 191 bytes):
 *
 *   keccak256(
 *     "escrow" || version[1] || network_id[32] || contract_id[32] ||
 *     "reserve" || deposit_id[32] || quote_hash[32] || settler[33] || source_amount[16,LE]
 *   )
 */
export function computeReserveHash(params: EscrowReserveParams, domain: EscrowDomain): Uint8Array {
  requireBytes32('depositId', params.depositId);
  requireBytes32('quoteHash', params.quoteHash);
  if (isZeroBytes32(params.depositId)) throw new ZeroDepositIdError();
  if (isZeroBytes32(params.quoteHash)) throw new ZeroQuoteHashError();
  const sourceAmount = encodeAmount16(params.sourceAmount);
  if (params.sourceAmount === 0n) throw new ZeroSourceAmountError();

  return hashWithDomain(
    domain,
    'reserve',
    params.depositId,
    params.quoteHash,
    params.settler.toBytes33(),
    sourceAmount,
  );
}
