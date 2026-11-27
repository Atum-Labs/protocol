import { randomBytes } from 'crypto';

// On-chain contract constants (from the escrow program's programs/escrow/src/constants.rs)
/**
 * The compute-unit limit a deposit transaction must REQUEST.
 *
 * Solana's default per-transaction budget is 200k CUs and a deposit with this witness does not fit in
 * it. This package hashes and encodes; it never builds instructions, so the transaction is the
 * caller's to assemble. A client that does not prepend
 * `ComputeBudgetProgram.setComputeUnitLimit(DEPOSIT_COMPUTE_UNIT_LIMIT)` gets
 * "exceeded CUs meter at BPF instruction" and the deposit fails outright.
 *
 * Exported because it was previously reachable only from the Anchor suite's test helper, where
 * no client could find it. Kept in step with that helper and with the Go mirror by
 * compute_budget_parity_test.go.
 */
export const DEPOSIT_COMPUTE_UNIT_LIMIT = 400_000;

export const REPLAY_SLOTS = 235;
export const MAX_VALID_SLOT = REPLAY_SLOTS - 1;
/**
 * Bounded bucket set so the replay_bucket PDAs are reused instead of one created per payment.
 * REPLAY_BUCKETS * REPLAY_SLOTS = 60160 nonces per authority per 256-512s replay window (a slot is
 * reusable once its last use is two 256s slices away).
 */
export const REPLAY_BUCKETS = 256;
const NONCE_BUCKET_SHIFT = 32n;

/**
 * Generates a replay-safe nonce for the Solana escrow deposit instruction.
 *
 * The nonce format is defined by the on-chain escrow program:
 *   - Lower 8 bits: slot index (0 to 234), extracted on-chain via `nonce & 0xFF`
 *   - Upper 32 bits: bucket ID (0 to REPLAY_BUCKETS-1), used on-chain as PDA seed via `nonce.to_le_bytes()[4..]`
 *
 * Stateless: both fields are drawn per call from a CSPRNG. Uniqueness is only required
 * within one authority and bucket while the program still remembers it (the same or the adjacent
 * 256s slice), which check_replay enforces.
 */
export function generateNonce(): bigint {
  // Bucket drawn from the bounded set; 2^32 is a multiple of any power-of-two count, so unbiased.
  const bucketID = randomBytes(4).readUInt32LE(0) % REPLAY_BUCKETS;

  // Random slot in valid range (0-234) using rejection sampling
  let slot: number;
  do {
    slot = randomBytes(1)[0];
  } while (slot >= REPLAY_SLOTS);

  return (BigInt(bucketID) << NONCE_BUCKET_SHIFT) | BigInt(slot);
}
