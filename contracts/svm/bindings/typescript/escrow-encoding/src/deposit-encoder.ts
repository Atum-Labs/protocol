import { Pubkey } from './pubkey';
import { encodeU64LE, keccak256, stringToBytes, isZeroBytes32 } from './encoding-utils';
import { EscrowDomain, escrowDomainPrefixBytes } from './escrow-domain';
import {
  ZeroDepositRequestHashError,
  EmptyDestinationError,
  DestinationTooLongError,
  ZeroDepositorError,
  ZeroMintError,
  ZeroAmountError,
  ZeroReserverError,
  ZeroReleaserError,
} from './errors';

/**
 * Parameters needed to compute a deposit message hash.
 */
export interface EscrowDepositParams {
  /**
   * The depositor-signed commitment to the offchain deposit request. Formerly `paymentId`; renamed for
   * parity with EVM and TVM, which call the same value `depositRequestHash`. Hash-neutral rename.
   */
  depositRequestHash: Uint8Array;
  depositor: Pubkey;
  mint: Pubkey;
  amount: bigint;
  reserver: Pubkey;
  releaser: Pubkey;
  nonce: bigint;
  issuedAt: bigint;
  deadline: bigint;
}

/**
 * Computes the deposit_hash for the Solana escrow deposit operation, pre-destination.
 *
 * Hash formula (Rust source: `programs/escrow/src/utils/signatures.rs:compute_deposit_hash`):
 *
 *   keccak256(
 *     "escrow" || version[1] || cluster_id[32] || program_id[32] ||
 *     "deposit" || deposit_request_hash[32] || depositor[32] || mint[32] ||
 *     amount[8,LE] || reserver[32] || releaser[32] ||
 *     nonce[8,LE] || issued_at[8,LE] || deadline[8,LE]
 *   )
 *
 * This layout is FROZEN. It is what signature_domain_version 1..=3 committed to, and historical deposits
 * are still verified against it, so it must never change. The destination commitment lives in
 * {@link computeDepositHashV2} instead.
 *
 * Witness revision to domain version, since the two numbers deliberately do not match:
 *
 *   domain v1, v2:  computeDepositHash   + computeReserveHash   / computeReleaseHash   / computeRefundHash
 *   domain v3:      computeDepositHash   + computeReserveHashV2 / computeReleaseHashV2 / computeRefundHashV2
 *   domain v4:      computeDepositHashV2 + computeReserveHashV2 / computeReleaseHashV2 / computeRefundHashV2
 *
 * Each suffix counts revisions of ITS OWN witness; deposit changed one revision later than the other
 * three.
 */
export function computeDepositHash(
  params: EscrowDepositParams,
  domain: EscrowDomain,
): Uint8Array {
  if (params.depositRequestHash.length !== 32 || isZeroBytes32(params.depositRequestHash)) {
    throw new ZeroDepositRequestHashError();
  }
  if (params.depositor.isZero()) throw new ZeroDepositorError();
  if (params.mint.isZero()) throw new ZeroMintError();
  if (params.amount === 0n) throw new ZeroAmountError();
  if (params.reserver.isZero()) throw new ZeroReserverError();
  if (params.releaser.isZero()) throw new ZeroReleaserError();

  return keccak256(
    ...escrowDomainPrefixBytes(domain),
    stringToBytes('deposit'),
    params.depositRequestHash,
    params.depositor.toBytes(),
    params.mint.toBytes(),
    encodeU64LE(params.amount),
    params.reserver.toBytes(),
    params.releaser.toBytes(),
    encodeU64LE(params.nonce),
    encodeU64LE(params.issuedAt),
    encodeU64LE(params.deadline),
  );
}

/**
 * Maximum byte length of the committed destination.
 *
 * 256 is uniform across EVM, TVM and SVM so one client signing-policy rule covers every chain. Note the
 * Solana-specific ceiling beneath it: a LEGACY transaction admits only about 152 bytes of destination at
 * the current 17-key/2-signature deposit shape, so anything larger requires a v0 transaction with an
 * address lookup table. Real destinations are ~103 bytes (eip155) and ~135 bytes (solana), so normal
 * traffic never approaches either limit.
 */
export const MAX_DESTINATION_LEN = 256;

/**
 * keccak256 of the destination's UTF-8 bytes.
 *
 * The single place the destination becomes bytes for hashing, mirroring the on-chain
 * `compute_destination_hash`. Keeping it separate is what makes the hash-first rule enforceable rather
 * than conventional: computeDepositHashV2 never concatenates a string.
 */
export function computeDestinationHash(destination: string): Uint8Array {
  return keccak256(stringToBytes(destination));
}

/**
 * Computes the signature_domain_version 4 deposit_hash: {@link computeDepositHash}'s preimage with
 * keccak256(destination) inserted directly after deposit_request_hash.
 *
 * Hash formula (Rust source: `programs/escrow/src/utils/signatures.rs:compute_deposit_hash`):
 *
 *   keccak256(
 *     "escrow" || version[1] || cluster_id[32] || program_id[32] ||
 *     "deposit" || deposit_request_hash[32] || destination_hash[32] || depositor[32] || mint[32] ||
 *     amount[8,LE] || reserver[32] || releaser[32] ||
 *     nonce[8,LE] || issued_at[8,LE] || deadline[8,LE]
 *   )
 *
 * `destination` is the plaintext `<CAIP-19 asset>@<account>` the payer commits to: lowercase throughout
 * EXCEPT base58 segments (Solana genesis reference, SPL mint, account), which are case-significant and
 * preserved byte-for-byte. It is NOT normalised here — the commitment is over the exact bytes the payer
 * signed, so re-casing or trimming would silently produce a hash the program rejects.
 *
 * The preimage is spelled out rather than delegating to computeDepositHash because each revision must be
 * independently frozen: sharing the construction would let a future edit to one silently change the
 * other's bytes.
 */
export function computeDepositHashV2(
  params: EscrowDepositParams,
  destination: string,
  domain: EscrowDomain,
): Uint8Array {
  if (params.depositRequestHash.length !== 32 || isZeroBytes32(params.depositRequestHash)) {
    throw new ZeroDepositRequestHashError();
  }
  if (params.depositor.isZero()) throw new ZeroDepositorError();
  if (params.mint.isZero()) throw new ZeroMintError();
  if (params.amount === 0n) throw new ZeroAmountError();
  if (params.reserver.isZero()) throw new ZeroReserverError();
  if (params.releaser.isZero()) throw new ZeroReleaserError();
  if (destination.length === 0) throw new EmptyDestinationError();
  // Byte length, not UTF-16 code units: the program bounds the UTF-8 encoding, so a multi-byte
  // destination must be measured the same way here or the two sides disagree at the limit.
  if (stringToBytes(destination).length > MAX_DESTINATION_LEN) {
    throw new DestinationTooLongError();
  }

  return keccak256(
    ...escrowDomainPrefixBytes(domain),
    stringToBytes('deposit'),
    params.depositRequestHash,
    // Hash first: keccak256 concatenates without length prefixes, so injectivity depends on every
    // hashed field being fixed-width. Feeding the raw string would make it conditional on the
    // surrounding widths and diverge from the on-chain program, which hashes it too.
    computeDestinationHash(destination),
    params.depositor.toBytes(),
    params.mint.toBytes(),
    encodeU64LE(params.amount),
    params.reserver.toBytes(),
    params.releaser.toBytes(),
    encodeU64LE(params.nonce),
    encodeU64LE(params.issuedAt),
    encodeU64LE(params.deadline),
  );
}
