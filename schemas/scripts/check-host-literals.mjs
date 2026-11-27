#!/usr/bin/env node
/**
 * Fail when a service base URL appears outside the hosts.yaml SSOT.
 *
 * Catches:
 *   - https://…atum.network / https://…atumlabs.xyz as reachable addresses
 *     (not did:web: and not schemas.atum.network wire identifiers)
 *   - https://<svc>.atum.xyz that is not an SSOT URL and not a known
 *     non-service host (docs, schemas, static, apex)
 *
 * Scope is the published API specs and the payment-gateway-client surface.
 * wallet-orch and declaration fixtures are out: the former has no public
 * host; the latter still carry schemas.atum.network / did:web: wire IDs.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadHosts, ssotUrls, SCHEMAS_DIR } from "./hosts.mjs";

const REPO_ROOT = resolve(SCHEMAS_DIR, "..");

const SCAN_GLOBS = [
  "schemas/apis/payment-gateway/**",
  "schemas/apis/veri-fill/**",
  "schemas/apis/auth/**",
  "schemas/apis/x402/**",
  "schemas/apis/error/**",
  "schemas/apis/decline/**",
  "schemas/apis/counterparty-gateway/**",
];

const SKIP_DIR_RE =
  /(^|\/)(node_modules|dist|generated|testdata)(\/|$)/;

const ALLOW_FILE_RE =
  /(^|\/)(hosts\.yaml|hosts\.generated\.ts|hosts\.mjs|gen-hosts\.mjs|check-host-literals\.mjs|hosts\.test\.mjs)$/;

const DEPRECATED_URL_RE =
  /https?:\/\/[^\s"'`<>)\]},]+(?:atum\.network|atumlabs\.xyz)[^\s"'`<>)\]},]*/gi;

const ATUM_XYZ_URL_RE = /https?:\/\/[a-z0-9.-]*atum\.xyz[^\s"'`<>)\]},]*/gi;

const NON_SERVICE_HOSTS = new Set([
  "atum.xyz",
  "www.atum.xyz",
  "docs.atum.xyz",
  "schemas.atum.xyz",
  "static.atum.xyz",
]);

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    const m = url.match(/^https?:\/\/([^/:]+)/i);
    return m ? m[1] : "";
  }
}

function originOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url.replace(/\/[a-z0-9._-]*$/i, "");
  }
}

function isWireIdentifier(url) {
  const host = hostnameOf(url);
  if (host === "schemas.atum.network") return true;
  if (url.startsWith("did:web:")) return true;
  return false;
}

function listedFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--", ...SCAN_GLOBS],
    { cwd: REPO_ROOT, encoding: "buffer" },
  );
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((p) => !SKIP_DIR_RE.test(p) && !ALLOW_FILE_RE.test(p));
}

/** Find forbidden host literals in `text`. `rel` is only for the report. */
export function findHostHits(text, allowed, rel = "input") {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const scanned = line.replace(/did:web:[^\s"'`<>)\]},]*/g, "");
    for (const match of scanned.matchAll(DEPRECATED_URL_RE)) {
      if (isWireIdentifier(match[0])) continue;
      hits.push({ rel, line: idx + 1, url: match[0], why: "deprecated domain" });
    }
    for (const match of scanned.matchAll(ATUM_XYZ_URL_RE)) {
      const url = match[0].replace(/[.,;]+$/, "");
      const host = hostnameOf(url);
      if (NON_SERVICE_HOSTS.has(host)) continue;
      const origin = originOf(url);
      if (allowed.has(url) || allowed.has(origin)) continue;
      hits.push({
        rel,
        line: idx + 1,
        url,
        why: "service host not in schemas/apis/hosts.yaml",
      });
    }
  });
  return hits;
}

function main() {
  const hosts = loadHosts();
  const allowed = ssotUrls(hosts);
  const hits = [];

  for (const rel of listedFiles()) {
    const abs = resolve(REPO_ROOT, rel);
    hits.push(...findHostHits(readFileSync(abs, "utf8"), allowed, rel));
  }

  if (hits.length) {
    process.stderr.write(
      "Host literals that are not the SSOT (schemas/apis/hosts.yaml):\n",
    );
    for (const h of hits) {
      process.stderr.write(`  ${h.rel}:${h.line}: ${h.url} (${h.why})\n`);
    }
    process.stderr.write(
      "Add the host to hosts.yaml (then regenerate) or stop hard-coding it.\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `No stray service hosts under ${SCAN_GLOBS.length} API trees.\n`,
  );
}

export {
  DEPRECATED_URL_RE,
  ATUM_XYZ_URL_RE,
  NON_SERVICE_HOSTS,
  isWireIdentifier,
  hostnameOf,
  originOf,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
