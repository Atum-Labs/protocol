// Production did:web IssuerKeyResolver — TS mirror of the Go canonical
// did:web resolver.
//
// Resolves a `did:web:<host>[:<path>]` to the parsed verificationMethod
// set published at the canonical `https://<host>[/<path>]/.well-known/
// did.json` URL. Caches by issuer DID with LRU + TTL semantics; env-var
// overrides let staging / docker-compose route an issuer DID to a
// different URL without recompiling.
//
// Use the same envelope as the Go side: instantiate once at startup,
// share across all VC verifications. Concurrency-safe by construction
// (cache is mutex-guarded; fetch is per-call).
//
// CONTRACT WITH issuer-side publishing: the resolver expects the DID
// document shape the issuer publishes. Field set parsed:
//   - `id` (the DID itself; sanity-checked against the requested DID)
//   - `verificationMethod[].id` (DID URL incl. #fragment)
//   - `verificationMethod[].type` (e.g. "JsonWebKey2020")
//   - `verificationMethod[].publicKeyJwk` (the JWK form)
//
// Errors:
//   - `unsupportedDIDMethod` for non-did:web inputs.
//   - `malformedDID` for shape errors in the input DID.
//   - `fetchFailed` for HTTP errors / non-2xx responses.
//   - `parseFailed` for malformed JSON / unexpected shape.
//   - `emptyVMSet` when the document parses but has no verificationMethod.
//   - `unsupportedVMType` filters: returned set only includes
//     JsonWebKey2020 entries; if all entries are filtered, `emptyVMSet`.

import type {
  IssuerKeyResolver,
  VerificationMethod,
  VerificationMethodSet,
} from "./verify-vc.js";

export interface DIDWebResolverOptions {
  // Bound on each HTTP request. Default: 5000 ms.
  httpTimeoutMs?: number;
  // LRU + TTL cache TTL. Default: 3_600_000 ms (1 hour).
  cacheTTLMs?: number;
  // LRU cap on cache size. Default: 256.
  cacheCap?: number;
  // Override map: did:web host → override base URL. Use for staging
  // / docker-compose. Production callers leave this empty so canonical
  // resolution applies.
  overrides?: Map<string, string>;
  // Injectable fetch (for tests). Defaults to globalThis.fetch.
  fetch?: typeof fetch;
  // Injectable clock (for tests). Defaults to () => Date.now().
  clock?: () => number;
}

export type DIDWebResolverErrorReason =
  | "unsupportedDIDMethod"
  | "malformedDID"
  | "fetchFailed"
  | "parseFailed"
  | "emptyVMSet"
  | "unsupportedVMType";

export class DIDWebResolverError extends Error {
  reason: DIDWebResolverErrorReason;
  constructor(reason: DIDWebResolverErrorReason, message: string) {
    super(message);
    this.name = "DIDWebResolverError";
    this.reason = reason;
  }
}

interface CacheEntry {
  vmSet: VerificationMethodSet;
  expiresAt: number;
}

export class DIDWebResolver implements IssuerKeyResolver {
  private readonly httpTimeoutMs: number;
  private readonly cacheTTLMs: number;
  private readonly cacheCap: number;
  private readonly overrides: Map<string, string>;
  private readonly fetchFn: typeof fetch;
  private readonly clock: () => number;

  // Map ordering doubles as the LRU recency tracker — set() promotes
  // a key to most-recent; eviction pops from the front.
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: DIDWebResolverOptions = {}) {
    this.httpTimeoutMs = opts.httpTimeoutMs ?? 5_000;
    this.cacheTTLMs = opts.cacheTTLMs ?? 3_600_000;
    this.cacheCap = opts.cacheCap ?? 256;
    this.overrides = opts.overrides ?? new Map();
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.clock = opts.clock ?? (() => Date.now());

    if (this.httpTimeoutMs < 0) {
      throw new Error(
        `DIDWebResolver: httpTimeoutMs must be non-negative, got ${this.httpTimeoutMs}`
      );
    }
    if (this.cacheTTLMs < 0) {
      throw new Error(
        `DIDWebResolver: cacheTTLMs must be non-negative, got ${this.cacheTTLMs}`
      );
    }
    if (this.cacheCap < 0) {
      throw new Error(
        `DIDWebResolver: cacheCap must be non-negative, got ${this.cacheCap}`
      );
    }
  }

  async resolve(issuerDID: string): Promise<VerificationMethodSet> {
    const now = this.clock();
    const cached = this.cache.get(issuerDID);
    if (cached && cached.expiresAt > now) {
      // Promote to most-recently-used.
      this.cache.delete(issuerDID);
      this.cache.set(issuerDID, cached);
      return cached.vmSet;
    }

    const url = this.didWebToURL(issuerDID);
    const doc = await this.fetchDIDDocument(url, issuerDID);
    const vmSet = parseDIDDocument(doc, issuerDID);

    // Evict cold entries before insert. Map keys iterate insertion-order;
    // delete the oldest until under cap, then insert (which is now MRU).
    while (this.cache.size >= this.cacheCap) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(issuerDID, {
      vmSet,
      expiresAt: now + this.cacheTTLMs,
    });
    return vmSet;
  }

  private didWebToURL(did: string): string {
    if (!did.startsWith("did:web:")) {
      throw new DIDWebResolverError(
        "unsupportedDIDMethod",
        `DIDWebResolver: unsupported DID method (want did:web): ${JSON.stringify(did)}`
      );
    }
    const rest = did.slice("did:web:".length);
    if (rest === "") {
      throw new DIDWebResolverError(
        "malformedDID",
        `DIDWebResolver: did:web has no identifier: ${JSON.stringify(did)}`
      );
    }
    // did:web encoding: colons separate host and path segments,
    // colons within port use percent-encoding (%3A). Per the did:web
    // spec, "did:web:example.com:user:alice" → https://example.com/user/alice.
    const segments = rest.split(":");
    const host = decodeURIComponent(segments[0]!);
    const pathSegs = segments.slice(1).map((s) => decodeURIComponent(s));

    // Apply override: the override key matches the bare host segment
    // of the did:web (not the full DID). E.g. override map entry
    // ("atumlabs.xyz" → "http://issuer:8080") routes
    // "did:web:atumlabs.xyz" to that base URL with the same path tail.
    const overrideBase = this.overrides.get(host);
    if (overrideBase !== undefined) {
      const pathTail = pathSegs.length > 0 ? "/" + pathSegs.join("/") : "";
      return overrideBase.replace(/\/$/, "") + pathTail + "/.well-known/did.json";
    }

    const path = pathSegs.length > 0 ? "/" + pathSegs.join("/") : "";
    return `https://${host}${path}/.well-known/did.json`;
  }

  private async fetchDIDDocument(
    url: string,
    issuerDID: string
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    try {
      const res = await this.fetchFn(url, { signal: controller.signal });
      if (!res.ok) {
        throw new DIDWebResolverError(
          "fetchFailed",
          `DIDWebResolver: GET ${url} returned status ${res.status} for issuer ${JSON.stringify(issuerDID)}`
        );
      }
      try {
        return await res.json();
      } catch (err) {
        throw new DIDWebResolverError(
          "parseFailed",
          `DIDWebResolver: JSON parse failed for ${url} (issuer ${JSON.stringify(issuerDID)}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } catch (err) {
      if (err instanceof DIDWebResolverError) throw err;
      throw new DIDWebResolverError(
        "fetchFailed",
        `DIDWebResolver: fetch ${url} failed for issuer ${JSON.stringify(issuerDID)}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseDIDDocument(
  doc: unknown,
  issuerDID: string
): VerificationMethodSet {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new DIDWebResolverError(
      "parseFailed",
      `DIDWebResolver: DID document for ${JSON.stringify(issuerDID)} is not a JSON object`
    );
  }
  const d = doc as Record<string, unknown>;
  if (typeof d.id !== "string" || d.id === "") {
    throw new DIDWebResolverError(
      "parseFailed",
      `DIDWebResolver: DID document for ${JSON.stringify(issuerDID)} missing top-level "id"`
    );
  }
  // Reject documents whose `id` doesn't match the requested DID.
  // Defense against a malicious did:web host serving a document
  // claiming a different DID — without this check the resolver
  // would happily cache it under the requested-DID key.
  if (d.id !== issuerDID) {
    throw new DIDWebResolverError(
      "parseFailed",
      `DIDWebResolver: DID document id ${JSON.stringify(d.id)} does not match requested DID ${JSON.stringify(issuerDID)}`
    );
  }
  const vmRaw = d.verificationMethod;
  if (!Array.isArray(vmRaw) || vmRaw.length === 0) {
    throw new DIDWebResolverError(
      "emptyVMSet",
      `DIDWebResolver: DID document for ${JSON.stringify(issuerDID)} has no verificationMethod entries`
    );
  }
  const out: VerificationMethod[] = [];
  for (const entry of vmRaw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id === "") continue;
    if (typeof e.type !== "string" || e.type === "") continue;
    // MVP: only JsonWebKey2020 supported (matches the Go canonical).
    if (e.type !== "JsonWebKey2020") continue;
    const jwk = e.publicKeyJwk;
    if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) continue;
    out.push({
      id: e.id,
      type: e.type,
      publicKeyJwk: jwk as Record<string, unknown>,
    });
  }
  if (out.length === 0) {
    throw new DIDWebResolverError(
      "unsupportedVMType",
      `DIDWebResolver: DID document for ${JSON.stringify(issuerDID)} has verificationMethod entries but none are JsonWebKey2020`
    );
  }
  return out;
}

// loadOverridesFromEnv mirrors the Go did:web resolver's helper.
// Parses `DID_WEB_RESOLVER_OVERRIDES` as comma-separated `host=URL`
// pairs (same shape across the two languages so a single env var
// drives both verifiers in a mixed deploy). Returns an empty map if
// the env var is unset or empty; throws on shape errors so a
// misconfigured override surfaces at boot rather than silently
// defaulting to canonical resolution.
export function loadOverridesFromEnv(
  env: Record<string, string | undefined> = (typeof process !== "undefined"
    ? process.env
    : ({} as Record<string, string | undefined>))
): Map<string, string> {
  const out = new Map<string, string>();
  const raw = env.DID_WEB_RESOLVER_OVERRIDES;
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1 || eq === trimmed.length - 1) {
      throw new Error(
        `DID_WEB_RESOLVER_OVERRIDES: malformed entry ${JSON.stringify(trimmed)} (want host=URL)`
      );
    }
    const host = trimmed.slice(0, eq).trim();
    const url = trimmed.slice(eq + 1).trim();
    if (out.has(host)) {
      throw new Error(
        `DID_WEB_RESOLVER_OVERRIDES: duplicate override for host ${JSON.stringify(host)}`
      );
    }
    out.set(host, url);
  }
  return out;
}
