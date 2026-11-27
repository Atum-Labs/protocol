// Discover the third-party packages ACTUALLY inlined into a built dist/, and
// resolve each one's license metadata from the pnpm store.
//
// Both publishable packages bundle their @atum-labs/* siblings, which drags the
// siblings' transitive third-party deps into dist. tsup runs unminified, so
// esbuild leaves the pnpm store path of every inlined module in the output; that
// is what makes the set discoverable at all. Two consumers depend on this:
// the notices generator (attribution text) and the publish guard (copyleft +
// attribution completeness).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { distJsFiles } from './paths.mjs';

/** Licenses that conflict with shipping inside a statically-bundled Apache-2.0 artifact. */
export const COPYLEFT = /\b(AGPL|LGPL|GPL|MPL|EUPL|CDDL|OSL|EPL|CPL)\b/i;

const PNPM_PATH = /node_modules\/\.pnpm\/([^/]+)\/node_modules\/(@[^/]+\/[^/]+|[^/@][^/\s]*)/g;

/**
 * Scan a built dist/ for inlined third-party packages.
 *
 * @returns {Map<string, string>} package name -> pnpm store id
 */
export function scanInlined(distDir) {
  const blob = distJsFiles(distDir)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  const found = new Map();
  // Fresh regex state per call: PNPM_PATH is a module-level /g regex, so reusing
  // it across calls without resetting would resume from the previous lastIndex.
  PNPM_PATH.lastIndex = 0;
  let m;
  while ((m = PNPM_PATH.exec(blob))) {
    const [, id, name] = m;
    if (!name.startsWith('@atum-labs/') && !found.has(name)) found.set(name, id);
  }
  return found;
}

const LICENSE_FILE = /^(licen[sc]e|copying|notice)([.-].*)?$/i;

/** Best-effort license identification from license text, for packages that declare none. */
function detectFromText(t) {
  if (/unlicense\.org|released into the public domain/i.test(t)) return 'Unlicense';
  if (/GNU LESSER GENERAL PUBLIC/i.test(t)) return 'LGPL-3.0';
  if (/GNU GENERAL PUBLIC/i.test(t)) return 'GPL';
  if (/Mozilla Public License/i.test(t)) return 'MPL-2.0';
  if (/Apache License/i.test(t)) return 'Apache-2.0';
  if (/\bISC License\b/i.test(t)) return 'ISC';
  if (/Redistribution and use in source and binary/i.test(t)) return 'BSD';
  if (/Permission is hereby granted, free of charge/i.test(t)) return 'MIT';
  return null;
}

/** Normalize the several shapes a manifest `license` field takes. */
export function licenseOf(meta) {
  if (typeof meta.license === 'string') return meta.license;
  return meta.license?.type || meta.licenses?.[0]?.type || '';
}

/**
 * Resolve one inlined package's directory inside the pnpm store.
 * Returns null when it cannot be resolved (the caller must fail closed: an
 * unresolvable package is one whose license we cannot verify).
 */
export function storeDirFor(pnpmStore, name, id) {
  if (!pnpmStore) return null;
  const dir = join(pnpmStore, id, 'node_modules', name);
  return existsSync(join(dir, 'package.json')) ? dir : null;
}

/**
 * Full attribution record for one inlined package: version, license, author, and
 * the verbatim license text (MIT/BSD/… require the notice to travel with the
 * redistribution, so the text itself is reproduced, not just the identifier).
 */
export function attributionFor(pnpmStore, name, id) {
  const dir = pnpmStore ? join(pnpmStore, id, 'node_modules', name) : null;
  let version = id.split('@').pop().split('_')[0];
  let license = 'UNKNOWN';
  let author = '';
  let text = '';

  if (dir) {
    try {
      const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      version = pj.version || version;
      license = licenseOf(pj) || 'UNKNOWN';
      author =
        typeof pj.author === 'string'
          ? pj.author
          : pj.author?.name
            ? pj.author.name + (pj.author.email ? ' <' + pj.author.email + '>' : '')
            : '';
    } catch {
      /* fall through to UNKNOWN */
    }
    try {
      const lf = readdirSync(dir).find((f) => LICENSE_FILE.test(f));
      if (lf) text = readFileSync(join(dir, lf), 'utf8').trim();
    } catch {
      /* no license file */
    }
  }

  if (license === 'UNKNOWN' && text) {
    const d = detectFromText(text);
    if (d) license = d;
  }
  if (!text) {
    text = `[No license file is distributed inside this package. Declared license: ${license}${author ? '; author: ' + author : ''}.]`;
  }
  return { name, version, license, author, text };
}
