/**
 * Node only: the bundled registry plus chain files read from a directory at runtime, such as
 * ../overlays/localnet for a local test chain. A separate entry point
 * (`@atum-labs/contract-registry/overlay`) so the main import stays free of `fs`.
 * Mirrors the Go LoadWithOverlay, including its file checks.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAIN_FILES, type Chain, type Registry, load } from './index';

/**
 * Message schemes a Solana version may name; '' is the raw 32 byte hash. Equal to registry.go and to
 * the svm escrow encoding's MESSAGE_SCHEMES (overlay.test.ts checks).
 */
export const SVM_MESSAGES: ReadonlySet<string> = new Set(['', 'escrow-text-v1']);

const CHAIN_KEYS = new Set(['chain', 'name', 'mainnet', 'versions']);
const VERSION_KEYS = new Set([
  'id',
  'source',
  'escrow',
  'fulfillmentProxies',
  'permit2',
  'signature',
  'unrecordedFulfillmentProxies',
]);
const SIGNATURE_KEYS = new Set(['eip712Name', 'eip712Version', 'svmDomainVersion', 'svmMessage']);

function normalize(caip2: string, addr: string): string {
  const a = addr.trim();
  return caip2.startsWith('eip155:') ? a.toLowerCase() : a;
}

function checkKeys(obj: unknown, allowed: Set<string>, what: string): void {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${what} must be an object`);
  }
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new Error(`${what}: unknown field ${JSON.stringify(k)}`);
  }
}

/** The checks Go's Chain.validate runs, on a parsed chain file. */
export function validateChain(c: Chain): void {
  checkKeys(c, CHAIN_KEYS, 'chain');
  if (!c.chain || !c.name || !Array.isArray(c.versions) || c.versions.length === 0) {
    throw new Error('chain, name and at least one version are required');
  }
  const ids = new Set<string>();
  const escrows = new Map<string, string>();
  let prev = 0;
  for (const v of c.versions) {
    checkKeys(v, VERSION_KEYS, `version ${JSON.stringify(v?.id)}`);
    if (
      !v.id ||
      !v.source ||
      !v.escrow ||
      !Array.isArray(v.fulfillmentProxies) ||
      v.fulfillmentProxies.length === 0
    ) {
      throw new Error(
        `version ${JSON.stringify(v.id)}: id, source, escrow and fulfillmentProxies are required`,
      );
    }
    if (ids.has(v.id)) throw new Error(`version id ${JSON.stringify(v.id)} appears twice`);
    ids.add(v.id);
    const m = /^v(\d+)$/.exec(v.id);
    if (m) {
      const n = Number(m[1]);
      if (n <= prev) {
        throw new Error(
          `version ${JSON.stringify(v.id)} is listed after a newer one, but versions are oldest first`,
        );
      }
      prev = n;
    }
    const key = normalize(c.chain, v.escrow);
    const other = escrows.get(key);
    if (other !== undefined) {
      throw new Error(
        `escrow ${v.escrow} is under both ${JSON.stringify(other)} and ${JSON.stringify(v.id)}`,
      );
    }
    escrows.set(key, v.id);
    const s = v.signature;
    checkKeys(s, SIGNATURE_KEYS, `version ${JSON.stringify(v.id)} signature`);
    if (c.chain.startsWith('solana:')) {
      if (!s.svmDomainVersion || s.svmDomainVersion <= 0 || s.eip712Name || s.eip712Version) {
        throw new Error(
          `version ${JSON.stringify(v.id)}: a Solana version needs svmDomainVersion and no EIP-712 fields`,
        );
      }
      if (s.svmDomainVersion > 255) {
        throw new Error(
          `version ${JSON.stringify(v.id)}: svmDomainVersion ${s.svmDomainVersion} does not fit in one byte`,
        );
      }
      if (!SVM_MESSAGES.has(s.svmMessage ?? '')) {
        throw new Error(
          `version ${JSON.stringify(v.id)}: svmMessage ${JSON.stringify(s.svmMessage)} is not a known message scheme`,
        );
      }
    } else if (!s.eip712Name || !s.eip712Version || s.svmDomainVersion || s.svmMessage) {
      throw new Error(
        `version ${JSON.stringify(v.id)}: an EVM or Tron version needs eip712Name and eip712Version and no svmDomainVersion or svmMessage`,
      );
    }
    for (const p of Object.keys(v.unrecordedFulfillmentProxies ?? {})) {
      if (!v.fulfillmentProxies.some((a) => normalize(c.chain, a) === normalize(c.chain, p))) {
        throw new Error(
          `version ${JSON.stringify(v.id)}: unrecorded proxy ${p} is not in fulfillmentProxies`,
        );
      }
    }
  }
}

/**
 * Loads the bundled registry plus every *.json chain file in `dir`. An overlay file may only add a
 * chain the bundled set lacks and passes the same checks. An empty `dir` loads the bundled registry.
 */
export function loadWithOverlay(dir: string): Registry {
  if (dir === '') return load();
  const extra: Record<string, Chain> = {};
  const bundled = load();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    let c: Chain;
    try {
      c = JSON.parse(readFileSync(join(dir, e.name), 'utf8')) as Chain;
      validateChain(c);
    } catch (err) {
      throw new Error(`registry overlay ${dir}: registry ${e.name}: ${(err as Error).message}`);
    }
    const embedded = bundled.chain(c.chain);
    if (embedded !== undefined) {
      throw new Error(
        `registry overlay ${dir}: chain ${c.chain} is embedded as ${embedded.chain}, an overlay may only add chains`,
      );
    }
    extra[e.name] = c;
  }
  try {
    return load({ ...CHAIN_FILES, ...extra });
  } catch (err) {
    throw new Error(`registry overlay ${dir}: ${(err as Error).message}`);
  }
}
