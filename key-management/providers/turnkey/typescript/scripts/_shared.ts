// Shared helpers for the Turnkey provisioning scripts. These are thin operator-facing CLIs on
// top of the admin library (`../src/admin`) — no Turnkey logic lives here that the library
// doesn't already own. Keeping the glue in one place means every script parses args, loads
// credentials, builds a client, and writes secrets the same way.

import { generateP256KeyPair } from '@turnkey/crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIsolatedTurnkeyClient } from '../src/client-registry';
import { noopLogger } from '../src/logger';
import type { TurnkeyClient } from '../src/client';

export const DEFAULT_API_URL = 'https://api.turnkey.com';

/** Minimal `--flag value` / `--bool` parser. No dependency, matches the settler-agent scripts. */
export function argParser(argv: string[] = process.argv.slice(2)) {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return {
    get,
    flag: (name: string): boolean => argv.includes(`--${name}`),
    required: (name: string): string => {
      const v = get(name);
      if (!v) throw new Error(`Missing required argument: --${name}`);
      return v;
    },
  };
}

/** Read an env var, throwing if unset. Credentials are ALWAYS taken from the environment, never
 * from CLI args, so they don't land in shell history or the process table. */
export function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Env var ${name} is unset or empty`);
  return v;
}

/** Load a dotenv-style file into process.env without overwriting anything already set.
 * Placed next to the scripts as `scripts/.env` (gitignored). */
export function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/** Load the conventional `scripts/.env` sitting next to these scripts. Resolved via
 * fileURLToPath so paths with spaces / non-POSIX separators are handled correctly. */
export function loadScriptEnv(): void {
  loadDotEnv(fileURLToPath(new URL('./.env', import.meta.url)));
}

export interface ApiKeyPair {
  /** Compressed P-256 public key hex (33 bytes / 66 chars) — the value Turnkey stores. */
  readonly publicKey: string;
  /** P-256 private key hex — the secret the holder signs with. NEVER commit or transmit. */
  readonly privateKey: string;
}

/** Generate a fresh P-256 API keypair (Turnkey's `API_KEY_CURVE_P256`). The private key never
 * leaves the operator's machine — only the public key is registered with Turnkey. */
export function generateApiKeyPair(): ApiKeyPair {
  const { publicKey, privateKey } = generateP256KeyPair();
  return { publicKey, privateKey };
}

/** Build a single-tenant client for `organizationId`, authenticated with the given API keypair.
 * concurrencyLimit=1 keeps these one-shot admin scripts well under Turnkey's per-org rate cap. */
export function makeClient(opts: {
  organizationId: string;
  apiUrl: string;
  apiPublicKey: string;
  apiPrivateKey: string;
}): TurnkeyClient {
  return createIsolatedTurnkeyClient(
    {
      organizationId: opts.organizationId,
      apiUrl: opts.apiUrl,
      apiPublicKey: opts.apiPublicKey,
      apiPrivateKey: opts.apiPrivateKey,
      concurrencyLimit: 1,
      requestTimeoutMs: 25_000,
      log: noopLogger,
    },
    noopLogger,
  );
}

// Three separate credential sets, one per phase, kept distinct in the environment:
//   - PARENT  (parent org root)      → create-sub-org only
//   - SUBORG  (sub-org root user)    → create-api-key, apply-policies
//   - AGENT   (sub-org non-root key) → test-policies (root would bypass the policies under test)

/** Parent-org credentials — used only to create a sub-org. `--parent-org` overrides the org id;
 * keys are always env-only. */
export function parentCreds(orgOverride?: string): {
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
} {
  return {
    organizationId: orgOverride ?? readEnv('TURNKEY_PARENT_ORG_ID'),
    apiPublicKey: readEnv('TURNKEY_PARENT_API_PUBLIC_KEY'),
    apiPrivateKey: readEnv('TURNKEY_PARENT_API_PRIVATE_KEY'),
  };
}

/** Sub-org ROOT user key — used to add users and author policies inside the sub-org. */
export function subOrgCreds(): { apiPublicKey: string; apiPrivateKey: string } {
  return {
    apiPublicKey: readEnv('TURNKEY_SUBORG_ROOT_API_PUBLIC_KEY'),
    apiPrivateKey: readEnv('TURNKEY_SUBORG_ROOT_API_PRIVATE_KEY'),
  };
}

/** Sub-org NON-ROOT (agent/machine) key — used to test policy enforcement under the agent identity. */
export function agentCreds(): { apiPublicKey: string; apiPrivateKey: string } {
  return {
    apiPublicKey: readEnv('TURNKEY_SUBORG_USER_API_PUBLIC_KEY'),
    apiPrivateKey: readEnv('TURNKEY_SUBORG_USER_API_PRIVATE_KEY'),
  };
}

/** True when a Turnkey activity did not fail but is waiting for additional quorum approvals. The
 * client surfaces this as a terminal error whose message carries the ACTIVITY_STATUS_CONSENSUS_NEEDED
 * status, so we match on that. */
export function isConsensusNeeded(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /CONSENSUS_NEEDED/.test(m);
}

/** Pull the Turnkey activityId out of a client error message so operators can find it to approve. */
export function activityIdFromError(err: unknown): string | undefined {
  const m = err instanceof Error ? err.message : String(err);
  return m.match(/activityId=([0-9a-f-]+)/i)?.[1];
}

/** Pull the intent fingerprint out of a client error message. APPROVE_ACTIVITY takes the
 * fingerprint rather than the activity id, so a consensus-pending script needs both. */
export function fingerprintFromError(err: unknown): string | undefined {
  const m = err instanceof Error ? err.message : String(err);
  return m.match(/fingerprint=(sha256:[0-9a-f]+)/i)?.[1];
}

/** Write a secrets file with 0600 perms and echo the path. Callers pass an object that includes
 * private keys — this is the single place those touch disk, so it's easy to audit and clean up. */
export function writeSecretJson(outPath: string, data: unknown): void {
  const abs = path.resolve(outPath);
  fs.writeFileSync(abs, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(abs, 0o600);
  console.log(`\nWrote ${abs} (mode 0600 — contains private keys; store securely, never commit).`);
}
