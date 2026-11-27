/**
 * Resolves the `issued_at` timestamp for a Stellar deposit authorization from the network's latest
 * closed ledger instead of the local wall clock.
 *
 * The escrow requires `issued_at <= ledger time`, and ledger time never moves backward, so the
 * latest closed ledger's close time read at build time is a safe lower bound at settlement. A raw
 * local clock ahead of the network would otherwise sign a deposit the escrow refuses as issued in
 * the future.
 *
 * The read is best-effort: on any failure, timeout or unresolved RPC it falls back to the local
 * clock minus a skew buffer, so a flaky endpoint degrades rather than blocking the payment.
 */

/** Reads the latest closed ledger's close time (unix seconds) from a Soroban RPC endpoint. */
export type StellarLedgerCloseTimeReader = (rpcUrl: string, timeoutMs: number) => Promise<bigint>;

/**
 * Default public Soroban RPC per CAIP-2 reference. Only the test network has an open endpoint; the
 * public network's is run by providers, so it, and a standalone network, need `stellarRpcUrl`.
 */
export const DEFAULT_STELLAR_RPC_URLS: Record<string, string> = {
  testnet: 'https://soroban-testnet.stellar.org',
};

/** Give up on the ledger read after this and use the fallback. */
export const STELLAR_CLOCK_RPC_TIMEOUT_MS = 2000;

/** Fallback: back-date the local clock by this many seconds when the ledger read fails. */
export const STELLAR_ISSUED_AT_FALLBACK_SKEW_SECS = 45n;

/** The RPC url for a Stellar source chain id: the explicit override, else the default, else undefined. */
export function resolveStellarRpcUrl(sourceChainId: string, override?: string): string | undefined {
  if (override) return override;
  const reference = sourceChainId.split(':')[1];
  return reference ? DEFAULT_STELLAR_RPC_URLS[reference] : undefined;
}

/** Default reader: `getLatestLedger`, whose `closeTime` is the close time in seconds. */
export const readLatestLedgerCloseTime: StellarLedgerCloseTimeReader = async (
  rpcUrl,
  timeoutMs,
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger' }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Stellar RPC ${rpcUrl} returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as { result?: { closeTime?: unknown } };
    const closeTime = json?.result?.closeTime;
    if (typeof closeTime !== 'string' && typeof closeTime !== 'number') {
      throw new Error('Stellar getLatestLedger response has no closeTime');
    }
    const seconds = BigInt(closeTime);
    if (seconds <= 0n) throw new Error('Stellar getLatestLedger closeTime is not positive');
    return seconds;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Resolve the `issued_at` (seconds) to stamp on a Stellar deposit: the latest closed ledger's close
 * time, or the local clock minus a skew buffer when no RPC resolves or the read fails or times out.
 * `reader` is injectable so tests stay offline.
 */
export async function resolveStellarIssuedAt(opts: {
  sourceChainId: string;
  rpcUrlOverride?: string;
  reader?: StellarLedgerCloseTimeReader;
  timeoutMs?: number;
}): Promise<bigint> {
  const rpcUrl = resolveStellarRpcUrl(opts.sourceChainId, opts.rpcUrlOverride);
  if (rpcUrl) {
    try {
      const reader = opts.reader ?? readLatestLedgerCloseTime;
      return await reader(rpcUrl, opts.timeoutMs ?? STELLAR_CLOCK_RPC_TIMEOUT_MS);
    } catch {
      // Fall through to the local clock, back-dated.
    }
  }
  return BigInt(Math.floor(Date.now() / 1000)) - STELLAR_ISSUED_AT_FALLBACK_SKEW_SECS;
}
