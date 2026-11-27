// Builds throwaway package trees on disk so each guard can be exercised against a
// real filesystem without an npm pack/install round-trip.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { HEADER } from '../src/entries.mjs';

const created = [];

export function tempDir(prefix = 'publish-guard-test-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

export function cleanupAll() {
  while (created.length) rmSync(created.pop(), { recursive: true, force: true });
}

export function writeFile(root, rel, contents) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, contents);
  return p;
}

/** A dist file carrying the Apache-2.0 header, as the stamper would leave it. */
export const stamped = (body = 'module.exports = {};\n') => HEADER + body;

/** A dist file with no header — a dependency chunk, or an unstamped entry. */
export const unstamped = (body = 'module.exports = {};\n') => body;

/**
 * A minimal but realistic package tree.
 *
 * @param {object} opts
 * @param {object} [opts.manifest]  merged over the default manifest
 * @param {Record<string,string>} [opts.dist]  dist-relative path -> contents
 * @param {string} [opts.notices]   THIRD-PARTY-NOTICES.txt contents (omit to skip the file)
 */
export function makePackage({ manifest = {}, dist = {}, notices } = {}) {
  const root = tempDir();
  const pkg = {
    name: '@atum-labs/fixture',
    version: '1.0.0',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    license: 'Apache-2.0',
    ...manifest,
  };
  writeFile(root, 'package.json', JSON.stringify(pkg, null, 2));
  writeFile(root, 'LICENSE', 'Apache-2.0\n');
  writeFile(root, 'README.md', '# fixture\n');
  writeFile(root, 'dist/index.d.ts', 'export {};\n');
  for (const [rel, contents] of Object.entries(dist)) writeFile(root, join('dist', rel), contents);
  if (notices !== undefined) writeFile(root, 'THIRD-PARTY-NOTICES.txt', notices);
  return { root, distDir: join(root, 'dist'), pkg };
}

/**
 * A package store so the license scans have something to resolve. Pass the
 * returned `store` explicitly: the resolvers walk up from a package root to find
 * one, and a fixture in a temp directory has none above it.
 *
 * @param {Array<{name: string, id?: string, version?: string, license?: string, author?: string, licenseText?: string}>} packages
 * @returns {{ store: string }}
 */
export function makePnpmStore(packages) {
  const root = tempDir();
  const store = join(root, 'node_modules', '.pnpm');
  // Created even when empty, so "store exists but holds nothing" is testable.
  mkdirSync(store, { recursive: true });
  for (const p of packages) {
    const id = p.id ?? `${p.name}@${p.version ?? '1.0.0'}`;
    const dir = join(store, id, 'node_modules', p.name);
    mkdirSync(dir, { recursive: true });
    const manifest = { name: p.name, version: p.version ?? '1.0.0' };
    // An empty-string license models a package that declares none, which sends the
    // generator down its detect-from-text path.
    if (p.license !== undefined) manifest.license = p.license;
    else manifest.license = 'MIT';
    if (p.author) manifest.author = p.author;
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
    if (p.licenseText) writeFileSync(join(dir, 'LICENSE'), p.licenseText);
  }
  return { store };
}

/**
 * A dist body that looks like unminified tsup output: esbuild leaves the pnpm
 * store path of every inlined module in a comment, which is what makes the
 * inlined set discoverable.
 */
export function inlinedRef(name, id) {
  return `// ../../node_modules/.pnpm/${id}/node_modules/${name}/dist/index.js\n`;
}
