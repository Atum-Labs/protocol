// Stamp the Apache-2.0 notice onto a package's own entry files.
//
// It must not be applied to the dependency chunks: those contain third-party
// open-source code, distributed under its own licenses. Asserting Atum's
// copyright over that code would be inaccurate. `checkEntryHeaders` (see
// check.mjs) enforces both directions before a publish.
//
// Runs after the bundler, from each package's `build` script. A CLI entry file
// begins with a `#!/usr/bin/env node` shebang, which must remain the first line,
// so the notice is inserted immediately after it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEADER, MARKER, entriesForPackage } from './entries.mjs';

/**
 * @param {object} opts
 * @param {string} opts.pkgRoot   package root (contains package.json and dist/)
 * @param {(msg: string) => void} [opts.log]
 * @returns {string[]} the dist-relative entries that were stamped or already carried the header
 */
export function stampEntryHeaders({ pkgRoot, log = console.log }) {
  const entries = entriesForPackage(pkgRoot);
  const dist = join(pkgRoot, 'dist');

  for (const name of entries) {
    const p = join(dist, name);
    // readFileSync throws if a derived entry is missing (renamed export, broken
    // build) — that must fail the build loudly rather than ship an unstamped file.
    const src = readFileSync(p, 'utf8');
    if (src.includes(MARKER)) continue;
    if (src.startsWith('#!')) {
      // Keep the shebang on line 1; insert the header immediately after it.
      const nl = src.indexOf('\n');
      const shebang = src.slice(0, nl + 1);
      writeFileSync(p, shebang + HEADER + src.slice(nl + 1));
    } else {
      writeFileSync(p, HEADER + src);
    }
  }

  log(`stamped Apache-2.0 header on entry files: ${entries.join(', ')}`);
  return entries;
}
