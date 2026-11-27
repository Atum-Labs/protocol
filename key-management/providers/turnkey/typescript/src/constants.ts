// Shared constants for the Turnkey provider. Hoisted here so the HTTP client's retry
// schedule and the boot-time discovery's retry schedule stay in lockstep — operators
// tweaking one have a single source of truth.

/**
 * Exponential backoff schedule (ms) applied to retryable Turnkey failures. The number of
 * entries also caps the maximum retry count. Honored by `client.ts:queryPost` and
 * `signer-base.ts:resolveTurnkeyAccountAddress` alike.
 */
export const TURNKEY_RETRY_BACKOFF_MS = [500, 2_000, 8_000] as const;
