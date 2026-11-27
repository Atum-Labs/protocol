// Generate THIRD-PARTY-NOTICES.txt from the third-party packages ACTUALLY inlined
// into a built dist/ (see inlined.mjs for how the set is discovered).
//
// Run after the package's build:
//   pnpm gen:notices
//
// `pnpm check:publishable` then verifies the result: no copyleft is inlined, and
// every inlined package is attributed here (MIT/BSD/… require the notice to travel
// with the redistribution). Regenerate whenever the bundled dependency set
// changes. Do NOT hand-edit THIRD-PARTY-NOTICES.txt — edit this generator.
//
// The output format is intentionally stable, so regenerating after a dependency
// change produces a reviewable diff rather than a wholesale rewrite.
// Package-specific text is confined to `displayName` and `externalDepsNote`.
//
// Every package that uses this guard ships Apache-2.0, so the header
// asserts that unconditionally (see the license paragraph below). A package
// published under a different license would need that paragraph parameterized
// before it could use this generator.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanInlined, attributionFor } from './inlined.mjs';
import { findPnpmStore } from './paths.mjs';

/**
 * @param {object} opts
 * @param {string} opts.pkgRoot           package root (contains dist/)
 * @param {string} opts.displayName       published package name, as it appears in the header
 * @param {string} opts.externalDepsNote  verbatim sentence fragment naming the deps this file does NOT cover
 * @param {string} [opts.pnpmStore]       package store to resolve licenses from; defaults to the
 *                                        nearest one above `pkgRoot`. Injectable so the
 *                                        license-resolution paths are testable against a fixture.
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ path: string, components: number, byLicense: Record<string, number> }}
 */
export function generateNotices({
  pkgRoot,
  displayName,
  externalDepsNote,
  pnpmStore = findPnpmStore(pkgRoot),
  log = console.log,
}) {
  const distDir = join(pkgRoot, 'dist');

  const found = scanInlined(distDir);
  const rows = [...found]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, id]) => attributionFor(pnpmStore, name, id));

  const byLicense = {};
  for (const r of rows) byLicense[r.license] = (byLicense[r.license] || 0) + 1;
  const copyleft = rows.filter((r) => /LGPL|GPL|MPL|EUPL|CDDL/i.test(r.license));
  const apache = rows.filter((r) => /Apache/i.test(r.license));

  // The license paragraph is load-bearing and must not be dropped: without it a
  // file that reproduces a page of MIT text is easily read as the package's own
  // license. It states that the package is Apache-2.0, this file is not that
  // license, and these notices cover only the bundled components.
  let head = `THIRD-PARTY SOFTWARE NOTICES AND INFORMATION
==============================================================================
${displayName}

${displayName} is licensed under the Apache License, Version 2.0, as stated
in the package-root LICENSE file. THIS file is not that license. This
package includes the third-party software identified below; the licenses and
notices reproduced here apply only to those third-party components. They do not
modify the Apache-2.0 license governing this package or any Atum-authored code.

The published artifact of this package (the compiled code under dist/) statically
bundles the third-party open-source components listed below; their source is
redistributed within this package, so their license and copyright notices are
reproduced here. Components and versions were taken from the exact modules the
build inlined. This file does NOT cover packages the consumer installs separately
${externalDepsNote} — those ship under their own licenses and are not
redistributed here.

LICENSE SUMMARY (${rows.length} component${rows.length === 1 ? '' : 's'})
------------------------------------------------------------------------------
${Object.entries(byLicense)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `  ${String(v).padStart(3)}  ${k}`)
  .join('\n')}
`;
  if (copyleft.length) {
    head += `
!! ATTENTION — COPYLEFT COMPONENT(S), review before distribution:
${copyleft
  .map(
    (r) =>
      `   * ${r.name} ${r.version} (${r.license}) — statically bundled; copyleft terms differ\n     materially from the permissive licenses above and may require action for an\n     Apache-2.0 distribution. Do NOT publish until reviewed.`,
  )
  .join('\n')}
`;
  }
  if (apache.length) {
    head += `
   Apache-2.0 component(s): ${apache.map((r) => r.name).join(', ')} — retain the NOTICE text where provided.
`;
  }
  head += `==============================================================================\n\n`;

  const body = rows
    .map(
      (r) => `------------------------------------------------------------------------------
${r.name}  ${r.version}   (${r.license})${r.author ? '\nAuthor: ' + r.author : ''}
------------------------------------------------------------------------------

${r.text}
`,
    )
    .join('\n');

  const outPath = join(pkgRoot, 'THIRD-PARTY-NOTICES.txt');
  writeFileSync(outPath, head + body + '\n');
  log(
    `wrote THIRD-PARTY-NOTICES.txt: ${rows.length} component${rows.length === 1 ? '' : 's'} (${Object.entries(
      byLicense,
    )
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')})`,
  );
  return { path: outPath, components: rows.length, byLicense };
}
