// Filesystem helpers shared by the guard, the notices generator, and the stamper.
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

/** Recursively list every file under `dir` (absolute paths). */
export function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

/** Every built `.js` file under a package's dist/, recursively. */
export function distJsFiles(distDir) {
  return walk(distDir).filter((f) => f.endsWith('.js'));
}

/**
 * Locate the pnpm content-addressed store (`node_modules/.pnpm`) by walking up
 * from a package root.
 *
 * Both publishable packages sit one level below the repo root, so the previous
 * per-package scripts hardcoded `<pkgRoot>/../node_modules/.pnpm`. Walking up
 * instead keeps this correct for a package at any depth (this tooling package is
 * itself two levels down), which matters because the store path is what makes the
 * copyleft and attribution scans able to resolve a bundled package's license at
 * all — a wrong path silently blinds them.
 */
export function findPnpmStore(fromDir) {
  let dir = resolve(fromDir);
  for (;;) {
    const candidate = join(dir, 'node_modules', '.pnpm');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
