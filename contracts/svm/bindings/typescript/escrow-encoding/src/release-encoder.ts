import { keccak256, stringToBytes, isZeroBytes32 } from './encoding-utils';
import { EscrowDomain, escrowDomainPrefixBytes } from './escrow-domain';
import { ZeroDepositHashError } from './errors';

export interface EscrowReleaseParams {
  depositHash: Uint8Array;
}

/**
 * Computes the release message hash under the FROZEN pre-quote-hash layout
 * (signature_domain_version 1 and 2). See computeReleaseHashV2 below for v3+.
 *
 * Hash formula (the program's layout at domain versions 1 and 2):
 *
 *   keccak256(
 *     "escrow" || version[1] || cluster_id[32] || program_id[32] ||
 *     "release" || deposit_hash[32]
 *   )
 */
export function computeReleaseHash(
  params: EscrowReleaseParams,
  domain: EscrowDomain,
): Uint8Array {
  if (params.depositHash.length !== 32 || isZeroBytes32(params.depositHash)) {
    throw new ZeroDepositHashError();
  }

  return keccak256(
    ...escrowDomainPrefixBytes(domain),
    stringToBytes('release'),
    params.depositHash,
  );
}

/**
 * Computes the signature_domain_version 3+ release message hash, which binds the offchain quote hash.
 *
 * Hash formula (Rust source: `compute_release_hash`):
 *
 *   keccak256(
 *     "escrow" || version[1] || cluster_id[32] || program_id[32] ||
 *     "release" || deposit_hash[32] || quote_hash[32]
 *   )
 *
 * Additive: {@link computeReleaseHash} above is the frozen pre-quote-hash layout that domain versions 1
 * and 2 signed, and is unchanged.
 *
 * quote_hash is the value bound at reserve (stored on the deposit), so this does not re-validate it and
 * deliberately permits zero — mirroring the Go encoder and the on-chain program.
 */
export function computeReleaseHashV2(
  params: EscrowReleaseParams,
  quoteHash: Uint8Array,
  domain: EscrowDomain,
): Uint8Array {
  if (params.depositHash.length !== 32 || isZeroBytes32(params.depositHash)) {
    throw new ZeroDepositHashError();
  }

  return keccak256(
    ...escrowDomainPrefixBytes(domain),
    stringToBytes('release'),
    params.depositHash,
    quoteHash,
  );
}
