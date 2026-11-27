import { TurnkeyClient, type TurnkeyClientOpts } from './client';
import type { Logger } from './logger';

/**
 * Process-wide registry of `TurnkeyClient` instances, keyed by `(organizationId, apiPublicKey)`.
 *
 * Multiple chain signers in the same agent process target the same Turnkey sub-org and wallet.
 * Without a registry, each chain shim would spin up its own client — duplicating the stamper
 * initialization (one Web Crypto importKey per client), the HTTP connection pool, and most
 * importantly the concurrency semaphore that protects against the per-sub-org rate ceiling.
 *
 * The registry returns a shared instance so all three chain signers cooperate on a single
 * 10-slot-by-default semaphore against the sub-org. If a future deployment needs separate
 * pools (different sub-orgs per chain), the key already differentiates by org id.
 */
const registry = new Map<string, TurnkeyClient>();

function clientKey(orgId: string, apiPublicKey: string): string {
  // Org id is non-secret; public key is non-secret. The key is just an identity tuple, never logged.
  return `${orgId}:${apiPublicKey}`;
}

export function getOrCreateTurnkeyClient(opts: TurnkeyClientOpts): TurnkeyClient {
  const key = clientKey(opts.organizationId, opts.apiPublicKey);
  const existing = registry.get(key);
  if (existing) return existing;
  const fresh = new TurnkeyClient(opts);
  registry.set(key, fresh);
  return fresh;
}

/** Test utility — clears the registry. Not exported via the package barrel. */
export function __resetTurnkeyClientRegistryForTests(): void {
  registry.clear();
}

/** Build a `TurnkeyClient` directly without registry caching — useful when a specific call
 * site genuinely wants an isolated client (admin tooling running against the parent org). */
export function createIsolatedTurnkeyClient(opts: TurnkeyClientOpts, log: Logger): TurnkeyClient {
  return new TurnkeyClient({ ...opts, log });
}
