import { Address } from './address';
import { encodeAmount16, keccak256, requireBytes32 } from './encoding-utils';
import { Pubkey } from './pubkey';

/**
 * The ten-member tuple the escrow stores a hash of while a deposit is live, in EVM's ActiveDeposit order.
 * Release and refund rebuild it from their witness and compare.
 */
export interface EscrowActiveDeposit {
  depositor: Address;
  quoteHash: Uint8Array;
  depositRequestHash: Uint8Array;
  /** keccak256(destination), as computeDestinationHash returns it. */
  destinationHash: Uint8Array;
  token: Address;
  /** The stored amount, equal to the reserve's source_amount. */
  amount: bigint;
  /** The fee fixed at deposit, taken at release only. */
  feeAmount: bigint;
  reserver: Pubkey;
  releaser: Pubkey;
  settler: Address;
}

/** The three hash members are concatenated without length prefixes, so a short one next to a long one would
 * otherwise hash to a digest the contract never produces. */
export function checkActiveDepositWidths(d: EscrowActiveDeposit): void {
  requireBytes32('quoteHash', d.quoteHash);
  requireBytes32('depositRequestHash', d.depositRequestHash);
  requireBytes32('destinationHash', d.destinationHash);
}

/**
 * Computes what `get_deposit_hash(deposit_id)` returns. It is stored, not signed: there is no domain
 * prefix and no tag, because it never leaves the contract's storage.
 *
 * Hash formula (Rust source: `compute_active_deposit_hash`, 291 bytes):
 *
 *   keccak256(
 *     depositor[33] || quote_hash[32] || deposit_request_hash[32] || destination_hash[32] ||
 *     token[33] || amount[16,LE] || fee_amount[16,LE] || reserver[32] || releaser[32] || settler[33]
 *   )
 *
 * A client can compare it with the on-chain value to know a release or refund witness will be accepted
 * before paying for the transaction.
 */
export function computeActiveDepositHash(d: EscrowActiveDeposit): Uint8Array {
  checkActiveDepositWidths(d);
  return keccak256(
    d.depositor.toBytes33(),
    d.quoteHash,
    d.depositRequestHash,
    d.destinationHash,
    d.token.toBytes33(),
    encodeAmount16(d.amount),
    encodeAmount16(d.feeAmount),
    d.reserver.toBytes(),
    d.releaser.toBytes(),
    d.settler.toBytes33(),
  );
}
