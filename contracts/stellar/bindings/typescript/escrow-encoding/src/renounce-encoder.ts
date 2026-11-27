import { Address } from './address';
import { encodeU64LE } from './encoding-utils';
import { EscrowDomain, hashWithDomain } from './escrow-domain';

export interface EscrowRenounceParams {
  depositor: Address;
  token: Address;
  /**
   * The epoch of the delegate record being renounced: 1 for the first record of the (depositor, token),
   * +1 for each re-creation, kept across revokes. It binds the signature to one record, so it cannot kill
   * a later record of the same pair.
   */
  epoch: bigint;
  /** From the depositor's nonce bitmap, so the signature is single-use. */
  nonce: bigint;
  /**
   * Unix time in seconds. The contract refuses the renounce once its ledger time is past it, so a
   * signature that leaks unused stops working. The signer picks it; there is no upper bound.
   */
  deadline: bigint;
}

/**
 * Computes the digest the delegate signer signs to give up its authority (`renounce_delegate`; ed25519
 * over the 32 digest bytes).
 *
 * Hash formula (Rust source: `compute_renounce_hash`, 169 bytes):
 *
 *   keccak256(
 *     "escrow" || version[1] || network_id[32] || contract_id[32] ||
 *     "renounce" || depositor[33] || token[33] || epoch[8,LE] || nonce[8,LE] || deadline[8,LE]
 *   )
 */
export function computeRenounceHash(params: EscrowRenounceParams, domain: EscrowDomain): Uint8Array {
  return hashWithDomain(
    domain,
    'renounce',
    params.depositor.toBytes33(),
    params.token.toBytes33(),
    encodeU64LE(params.epoch),
    encodeU64LE(params.nonce),
    encodeU64LE(params.deadline),
  );
}
