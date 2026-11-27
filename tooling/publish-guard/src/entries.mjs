// Which built files are a package's own entry files, derived from its manifest.
//
// The manifest is the single source of truth: whatever a package advertises as an
// entry point is what carries the Apache-2.0 notice. Deriving the list means a
// newly added CLI or subpath export is covered automatically, rather than relying
// on a hand-maintained list staying in sync with the bundler config.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The Apache-2.0 notice stamped onto Atum-authored entry files. */
export const HEADER = `/*
 * Copyright 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
`;

/** Stable substring identifying an already-stamped file (idempotent re-runs). */
export const MARKER = 'Copyright 2026 Atum Labs, Inc.\n * SPDX-License-Identifier: Apache-2.0';

/** Strip a leading `./` or `/` and the `dist/` prefix, yielding a dist-relative path. */
const toDistRelative = (p) => p.replace(/^\.?\/?dist\//, '');

/**
 * Collect the `.js` targets an `exports` map advertises, at any nesting depth
 * (conditions like `types`/`import`/`default` nest arbitrarily).
 */
function collectExportTargets(node, out) {
  if (typeof node === 'string') {
    if (node.endsWith('.js')) out.add(node);
    return;
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectExportTargets(v, out);
  }
}

/**
 * Derive the dist-relative entry files from a package manifest: `main`, every
 * `bin` target, and every `.js` target in `exports`.
 *
 * Covers both shapes in this repo without special-casing either:
 *   - payment-gateway-client: `main` + 4 `bin` CLIs           -> 5 entries
 *   - mppx-atum-escrow:       `main` + `exports` (./client, ./server) -> 3 entries
 *
 * `types`/`.d.ts` targets are ignored (declaration files carry no code, and the
 * header belongs on the shipped runtime entries).
 */
export function deriveEntries(pkg) {
  const raw = new Set();
  if (typeof pkg.main === 'string' && pkg.main.endsWith('.js')) raw.add(pkg.main);
  for (const target of Object.values(pkg.bin ?? {})) {
    if (typeof target === 'string' && target.endsWith('.js')) raw.add(target);
  }
  collectExportTargets(pkg.exports, raw);

  const entries = [...raw].map(toDistRelative).filter(Boolean);
  // Deduplicate while keeping a stable, reproducible order so the stamper's log
  // line and any assertion over it do not depend on manifest key ordering.
  return [...new Set(entries)].sort();
}

/** Read a package manifest and derive its dist-relative entry files. */
export function entriesForPackage(pkgRoot) {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const entries = deriveEntries(pkg);
  if (entries.length === 0) {
    throw new Error(
      `no entry files derived from ${pkgRoot}/package.json — expected a "main", "bin", or "exports" ` +
        `entry pointing at a built .js file. Refusing to continue rather than silently stamping nothing.`,
    );
  }
  return entries;
}
