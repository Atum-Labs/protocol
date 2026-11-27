/**
 * Resolves the `issued_at` timestamp for a Solana deposit authorization from the
 * cluster's on-chain clock instead of the local wall clock.
 *
 * The escrow validates `now_sec >= issued_at` against Solana's `Clock` sysvar
 * (crates/replay/src/check.rs). That on-chain clock is global consensus and only
 * moves forward, so a value read at build time is a safe lower bound at
 * settlement, which removes the `Escrow_FutureTransaction` failure that a raw
 * `Date.now()` (client wall clock, possibly ahead of the lagging cluster clock)
 * can trigger.
 *
 * The read is best-effort: on any failure, timeout, or unresolved RPC it falls
 * back to `Date.now()` minus a skew buffer, so a flaky public endpoint degrades
 * to the previous behavior rather than blocking the payment.
 */

import type { Logger } from '@atum-labs/turnkey-signer';

/** Reads the cluster's on-chain unix timestamp (seconds) from an RPC endpoint. */
export type SolanaClusterUnixTimeReader = (rpcUrl: string, timeoutMs: number) => Promise<bigint>;

/**
 * Default public RPC per cluster, keyed by the CAIP-2 reference (the base58
 * genesis-hash prefix) in a `solana:<reference>` chain id. These are Solana's
 * open endpoints; they are rate-limited and not meant for heavy production
 * traffic, so callers with their own RPC should override via `solanaRpcUrl`.
 */
export const DEFAULT_SOLANA_RPC_URLS: Record<string, string> = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'https://api.mainnet-beta.solana.com',
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1: 'https://api.devnet.solana.com',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z': 'https://api.testnet.solana.com',
};

/** Solana Clock sysvar account. Its data holds the cluster `unix_timestamp`. */
const SYSVAR_CLOCK_ADDRESS = 'SysvarC1ock11111111111111111111111111111111';

/** Give up on the clock read after this and use the fallback. */
export const SOLANA_CLOCK_RPC_TIMEOUT_MS = 2000;

/**
 * Fallback: back-date wall-clock `issued_at` by this many seconds when the clock
 * read fails. This doubles as the maximum cluster lag the fallback tolerates: if
 * the cluster clock lags real time by more than this, the fallback can still
 * stamp a future `issued_at` and Escrow_FutureTransaction can recur. It is an
 * inherent trade-off of the wall-clock fallback, not a bug.
 */
export const SOLANA_ISSUED_AT_FALLBACK_SKEW_SECS = 45n;

/** Trim the on-chain read by a couple seconds so a node slightly ahead in slots stays a safe lower bound. */
export const SOLANA_CLOCK_READ_GUARD_SECS = 2n;

/**
 * Resolve the RPC url for a Solana source chain id: the explicit override wins,
 * otherwise the baked-in default for the cluster, otherwise undefined (unknown
 * cluster, e.g. localnet with no override → caller falls back to wall clock).
 */
export function resolveSolanaRpcUrl(sourceChainId: string, override?: string): string | undefined {
  if (override) return override;
  const reference = sourceChainId.split(':')[1];
  return reference ? DEFAULT_SOLANA_RPC_URLS[reference] : undefined;
}

/**
 * Parse the cluster `unix_timestamp` (i64 LE at byte offset 32) out of the
 * base64 Clock sysvar account data returned by `getAccountInfo`.
 * Layout: slot(8) epoch_start_timestamp(8) epoch(8) leader_schedule_epoch(8) unix_timestamp(8).
 */
export function readClockUnixTimeFromBase64(data: string): bigint {
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length < 40) {
    throw new Error(`Solana Clock sysvar data too short: ${bytes.length} bytes`);
  }
  return bytes.readBigInt64LE(32);
}

/** Default reader: a single `getAccountInfo` on the Clock sysvar, bounded by a timeout. */
export const readClusterUnixTime: SolanaClusterUnixTimeReader = async (rpcUrl, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [SYSVAR_CLOCK_ADDRESS, { encoding: 'base64' }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Solana RPC ${rpcUrl} returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as { result?: { value?: { data?: unknown[] } } };
    const data = json?.result?.value?.data?.[0];
    if (typeof data !== 'string') {
      throw new Error('Solana Clock sysvar account data missing from RPC response');
    }
    return readClockUnixTimeFromBase64(data);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Resolve the `issued_at` (seconds) to stamp on a Solana deposit. Prefers the
 * on-chain cluster clock (minus a small guard); falls back to the local wall
 * clock minus a skew buffer when no RPC is resolved or the read fails/times out.
 *
 * `reader` is injectable so tests stay offline.
 */
export async function resolveSolanaIssuedAt(opts: {
  sourceChainId: string;
  rpcUrlOverride?: string;
  reader?: SolanaClusterUnixTimeReader;
  timeoutMs?: number;
  /** Optional logger; warns when the clock read fails and we fall back to the wall clock. Defaults to no output. */
  logger?: Logger;
}): Promise<bigint> {
  const rpcUrl = resolveSolanaRpcUrl(opts.sourceChainId, opts.rpcUrlOverride);
  if (rpcUrl) {
    try {
      const reader = opts.reader ?? readClusterUnixTime;
      const onChain = await reader(rpcUrl, opts.timeoutMs ?? SOLANA_CLOCK_RPC_TIMEOUT_MS);
      return onChain - SOLANA_CLOCK_READ_GUARD_SECS;
    } catch (err) {
      // Surface the fallback so a silent degradation back to the pre-fix
      // wall-clock behavior is observable to anyone who wires a logger.
      opts.logger?.warn(
        { err: err instanceof Error ? err.message : String(err), rpcUrl },
        'Solana cluster clock read failed; falling back to wall clock for issued_at',
      );
    }
  }
  return BigInt(Math.floor(Date.now() / 1000)) - SOLANA_ISSUED_AT_FALLBACK_SKEW_SECS;
}
