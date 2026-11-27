// Guards the "publishes standalone" invariant plus the license-release invariants
// (ship exactly the intended files, no internal templates, no copyleft, header on
// our code and only on our code).
//
// Each package bundles its @atum-labs/* siblings into dist, so a published install
// must depend on no sibling and must type-check for a consumer out of the box.
// Checks:
//   1. no @atum-labs/* in runtime `dependencies` (they are bundled, dev-only),
//   2. no @atum-labs/* specifier left in the built dist (runtime .js or .d.ts),
//   3. no copyleft (GPL/LGPL/MPL/…) third-party inlined into the bundle, and every
//      inlined third-party package attributed in THIRD-PARTY-NOTICES.txt,
//   4. the Apache-2.0 header is on every entry file and on NO other dist file,
//   5. tarball manifest: license materials present, internal templates absent,
//      `license` field correct,
//   6. a real consumer type-check: pack the tarball, install it into a throwaway
//      project, and compile against it. A text search cannot catch a dangling
//      RELATIVE import to a file that is not shipped, nor a broken `exports`
//      subpath — only compiling the packed package does,
//   7. a runtime import/require of the packed package to catch resolution failures
//      tsc cannot see,
//   8. every published command-line entry point runs from a real install and
//      reports the package version.
//
// Checks 1-5 are pure functions over the filesystem, each returning its failure
// messages, so every invariant is unit-testable without an npm round-trip (see
// test/). `checkPublishable` composes them and adds 6-8, which need a real pack
// and install. Keeping them separable matters: a guard that cannot be tested can
// stop detecting without anyone noticing, while still reporting success.
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { distJsFiles, walk, findPnpmStore } from './paths.mjs';
import { scanInlined, storeDirFor, licenseOf, COPYLEFT } from './inlined.mjs';
import { MARKER, entriesForPackage } from './entries.mjs';

/** Internal-only templates that must never reach a published tarball. */
const INTERNAL_TEMPLATE =
  /^(RELEASE-CHECKLIST|SOURCE-HEADER|package-json-snippet|README-LICENSE-NOTICE)/i;

export const DEFAULT_REQUIRED_FILES = [
  'LICENSE',
  'README.md',
  'THIRD-PARTY-NOTICES.txt',
  'package.json',
];

/** 1. Siblings are bundled at build time, so they must not be runtime dependencies. */
export function checkSiblingDeps(pkg) {
  const bad = Object.keys(pkg.dependencies || {}).filter((d) => d.startsWith('@atum-labs/'));
  return bad.length
    ? [`@atum-labs/* in dependencies (must be bundled, not a runtime dep): ${bad.join(', ')}`]
    : [];
}

/**
 * 2. No @atum-labs/* specifier may survive in the built dist — that would mean
 * bundling leaked and the published install would try to resolve a package that
 * is not on the registry.
 *
 * A self-reference to this package is allowed: those appear only in preserved
 * JSDoc @example blocks, never as real imports.
 */
export function checkDistSpecifiers({ distDir, pkgName, pkgRoot }) {
  const failures = [];
  const specifier = new RegExp(
    `(?:require\\(|import\\(|from\\s+)['"](@atum-labs\\/(?!${pkgName.split('/')[1]}(?:['"/]))[^'"]+)['"]`,
  );
  for (const f of walk(distDir).filter((f) => f.endsWith('.js') || f.endsWith('.d.ts'))) {
    const m = readFileSync(f, 'utf8').match(specifier);
    if (m)
      failures.push(`${f.slice(pkgRoot.length)} references a sibling (${m[1]}) — bundling leaked`);
  }
  return failures;
}

/**
 * 3. License scan over the third-party packages actually inlined into dist.
 *
 * Copyleft (e.g. LGPL rpc-websockets via @solana/web3.js) statically bundled into
 * an Apache-2.0 package is a license conflict. And MIT/BSD/… still require the
 * copyright notice to travel with the redistribution, so every inlined package
 * must be attributed in the shipped notices file — this catches a dependency
 * change that inlines something new without regenerating them.
 *
 * @returns {{ failures: string[], inlinedCount: number }}
 */
export function checkInlinedLicenses({ distDir, pnpmStore, noticesPath }) {
  const failures = [];
  const inlined = scanInlined(distDir);
  const versions = new Map();

  for (const [name, id] of inlined) {
    const dir = storeDirFor(pnpmStore, name, id);
    if (!dir) {
      failures.push(
        `bundled third-party '${name}' — cannot resolve its license to verify it is not copyleft`,
      );
      continue;
    }
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (meta.version) versions.set(name, meta.version);
    const lic = licenseOf(meta);
    if (COPYLEFT.test(lic)) {
      failures.push(
        `copyleft component inlined into the tarball: ${name}@${meta.version || '?'} (${lic}). ` +
          `Externalize it (declare as a dependency so it is npm-installed, not bundled) ` +
          `before publishing this Apache-2.0 package.`,
      );
    }
  }

  // These bundles always inline the siblings' third-party deps, so zero detected
  // means the scan went blind (e.g. a minified build stripped the pnpm store-path
  // comments) — fail closed rather than pass vacuously.
  if (inlined.size === 0) {
    failures.push(
      'license scan detected no inlined third-party packages — the build may be minified ' +
        '(pnpm store paths stripped), leaving the copyleft/attribution scan blind. Build unminified before publishing.',
    );
    return { failures, inlinedCount: 0 };
  }

  if (!existsSync(noticesPath)) {
    failures.push('THIRD-PARTY-NOTICES.txt not found at the package root');
  } else {
    const notices = readFileSync(noticesPath, 'utf8');
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const attributed = (name, version) =>
      new RegExp('^' + escape(name) + '\\s+' + (version ? escape(version) + '\\s' : ''), 'm').test(
        notices,
      );
    const missing = [...inlined.keys()].filter((name) => !attributed(name));
    if (missing.length) {
      failures.push(
        `THIRD-PARTY-NOTICES.txt is missing attribution for inlined package(s): ${missing.join(', ')}. ` +
          `Regenerate it: pnpm gen:notices`,
      );
    }
    // The notices name the version they reproduce; a lockfile change that moves an
    // inlined package leaves them describing a version the tarball no longer ships.
    const stale = [...versions]
      .filter(([name, version]) => !missing.includes(name) && !attributed(name, version))
      .map(([name, version]) => `${name}@${version}`);
    if (stale.length) {
      failures.push(
        `THIRD-PARTY-NOTICES.txt attributes a different version than the build inlines: ${stale.join(', ')}. ` +
          `Regenerate it: pnpm gen:notices`,
      );
    }
  }
  return { failures, inlinedCount: inlined.size };
}

/**
 * 4. The Apache-2.0 header must be on every entry file, and on nothing else in dist.
 *
 * Both directions matter. Without the first, a newly added entry point publishes
 * without its notice. Without the second, a shared dependency chunk could assert
 * Atum copyright over third-party open-source code, which is inaccurate —
 * and packages that emit shared chunks make that a live possibility, not a
 * hypothetical one.
 */
export function checkEntryHeaders({ distDir, entries }) {
  const failures = [];
  const entryPaths = new Set(entries.map((e) => join(distDir, e)));

  for (const rel of entries) {
    const p = join(distDir, rel);
    if (!existsSync(p)) {
      failures.push(`entry file declared by the manifest is missing from dist: ${rel}`);
      continue;
    }
    if (!readFileSync(p, 'utf8').includes(MARKER)) {
      failures.push(
        `entry file is missing the Apache-2.0 header: dist/${rel}. ` +
          `Run the package build (it stamps entries via publish-guard stamp).`,
      );
    }
  }

  for (const f of distJsFiles(distDir)) {
    if (entryPaths.has(f)) continue;
    if (readFileSync(f, 'utf8').includes(MARKER)) {
      failures.push(
        `non-entry file carries the Apache-2.0 header: ${f.slice(distDir.length + 1)}. ` +
          `Dependency chunks embed third-party OSS; the header must not claim rights over it.`,
      );
    }
  }
  return failures;
}

/** 5. Ship the license materials, never ship internal-only templates, keep `license` correct. */
export function checkTarballManifest({
  manifestFiles,
  pkg,
  requiredFiles = DEFAULT_REQUIRED_FILES,
}) {
  const failures = [];
  for (const req of requiredFiles) {
    if (!manifestFiles.includes(req)) failures.push(`tarball is missing a required file: ${req}`);
  }
  const leaked = manifestFiles.filter((f) => INTERNAL_TEMPLATE.test(f));
  if (leaked.length)
    failures.push(`internal-only template(s) leaked into the tarball: ${leaked.join(', ')}`);
  if (pkg.license !== 'Apache-2.0') {
    failures.push(`package.json "license" must be "Apache-2.0", got "${pkg.license}"`);
  }
  return failures;
}

/**
 * Compose every check. Checks 6-7 pack the tarball ONCE and reuse it: the manifest
 * assertions read it with `tar`, then the consumer type-check and runtime import
 * install the same tgz. The tgz and temp project are removed in the `finally`
 * (covers every error path).
 *
 * @param {object} opts
 * @param {string} opts.pkgRoot
 * @param {object} opts.consumer
 * @param {string[]} [opts.requiredFiles]
 * @returns {boolean} true when publishable
 */
export function checkPublishable({
  pkgRoot,
  consumer,
  requiredFiles = DEFAULT_REQUIRED_FILES,
  log = console.log,
  error = console.error,
}) {
  let failed = false;
  const report = (messages) => {
    for (const m of messages) {
      failed = true;
      error('✗ ' + m);
    }
  };

  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const distDir = join(pkgRoot, 'dist');

  report(checkSiblingDeps(pkg));

  // The manifest names the entry files, so "was this built?" is asked of those rather
  // than of a fixed `dist/index.js`: a package may legitimately publish only subpath
  // exports (x402-atum-escrow ships one entry per role and no root entry).
  let entries;
  try {
    entries = entriesForPackage(pkgRoot);
  } catch (e) {
    report([`could not determine the package entry files: ${e.message}`]);
  }
  if (!existsSync(distDir) || (entries && !entries.some((e) => existsSync(join(distDir, e))))) {
    report([
      `no built entry file found under dist/ (expected ${entries?.join(', ') ?? 'the manifest entries'}) ` +
        `— build before running this check`,
    ]);
    error(`${pkg.name} is NOT publishable.`);
    return false;
  }

  report(checkDistSpecifiers({ distDir, pkgName: pkg.name, pkgRoot }));

  const { failures: licenseFailures, inlinedCount } = checkInlinedLicenses({
    distDir,
    pnpmStore: findPnpmStore(pkgRoot),
    noticesPath: join(pkgRoot, 'THIRD-PARTY-NOTICES.txt'),
  });
  report(licenseFailures);
  if (licenseFailures.length === 0) {
    log(
      `✅ license scan: ${inlinedCount} inlined third-party package(s), none copyleft, all attributed in THIRD-PARTY-NOTICES.txt`,
    );
  }

  if (entries) {
    const headerFailures = checkEntryHeaders({ distDir, entries });
    report(headerFailures);
    if (headerFailures.length === 0) {
      log(
        `✅ headers: Apache-2.0 notice on all ${entries.length} entry file(s), and on no dependency chunk`,
      );
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'publish-guard-'));
  const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'pipe' });
  const tgz = join(pkgRoot, `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`);
  try {
    run('npm', ['pack', '--ignore-scripts', '--silent'], pkgRoot);

    // Read the tarball with `tar` rather than parsing `npm pack --json` — its
    // output stream/shape varies across npm versions (that flakiness broke CI);
    // `tar -tzf` is version-stable.
    try {
      const manifestFiles = run('tar', ['-tzf', tgz])
        .toString()
        .split('\n')
        .map((s) => s.replace(/^package\//, '').trim())
        .filter(Boolean);
      const manifestFailures = checkTarballManifest({ manifestFiles, pkg, requiredFiles });
      report(manifestFailures);
      if (manifestFailures.length === 0) {
        log(
          `✅ manifest: ${manifestFiles.length} files, license materials present, no internal templates`,
        );
      }
    } catch (e) {
      const o = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
      report(['could not verify the tarball manifest:\n' + o]);
    }

    // 6. Real consumer type-check against the packed tarball.
    run('npm', ['init', '-y'], tmp);
    run(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        tgz,
        'typescript@5',
        ...(consumer.extraInstalls ?? []),
      ],
      tmp,
    );

    const sourceName = consumer.moduleFormat === 'esm' ? 'consumer.mts' : 'consumer.ts';
    writeFileSync(join(tmp, sourceName), renderConsumerSource(pkg.name, consumer));

    // Documentation snippets, compiled against the packed tarball rather than against src.
    // Importing symbols proves they exist; compiling the snippets proves the code we tell
    // customers to write still type-checks, so a renamed field or a changed argument shape
    // fails here instead of shipping in the README.
    const ext = consumer.moduleFormat === 'esm' ? '.mts' : '.ts';
    // Documentation imports the package by the name a consumer types, which is not always the
    // manifest name — a publish workflow may relabel the scope. Each alias the package declares is
    // rewritten to pkg.name so the snippet resolves against the installed tarball. Which names are
    // aliases is a fact about the package, so it lives in the package's config, not in here.
    const selfSpecifiers = (consumer.selfSpecifierAliases ?? []).map(
      (alias) => new RegExp(escapeForRegExp(alias), 'g'),
    );
    const snippetNames = (consumer.snippetFiles ?? []).map((rel, i) => {
      const name = `snippets-${i}${ext}`;
      const from = join(pkgRoot, rel);
      if (!existsSync(from)) {
        throw new Error(
          `publish-guard: consumer.snippetFiles names "${rel}", which does not exist in ${pkgRoot}`,
        );
      }
      const source = selfSpecifiers.reduce(
        (text, re) => text.replace(re, pkg.name),
        readFileSync(from, 'utf8'),
      );
      writeFileSync(join(tmp, name), source);
      return name;
    });

    const tscArgs = [];
    if (consumer.tsconfig) {
      writeFileSync(
        join(tmp, 'tsconfig.json'),
        JSON.stringify(
          { compilerOptions: consumer.tsconfig, files: [sourceName, ...snippetNames] },
          null,
          2,
        ),
      );
      tscArgs.push('-p', 'tsconfig.json');
    } else {
      // Default settings (no skipLibCheck override) is the point: it is what
      // catches a shipped .d.ts that imports a file the tarball does not include.
      tscArgs.push('--noEmit', '--strict', sourceName, ...snippetNames);
    }
    try {
      run(join(tmp, 'node_modules', '.bin', 'tsc'), tscArgs, tmp);
      log(
        `✅ consumer type-check passed against the packed tarball (${consumer.typeCheckLabel})` +
          (snippetNames.length
            ? `, including ${snippetNames.length} documentation snippet file(s)`
            : ''),
      );
    } catch (e) {
      const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
      report([
        `consumer type-check FAILED against the packed tarball (${consumer.typeCheckLabel}):\n` +
          out,
      ]);
    }

    // 7. Runtime import: tsc does not execute code, so it misses resolution
    //    failures (a bundled deep import kept without a .js extension, or a broken
    //    require shim). Load every entrypoint in a real node process.
    const isEsm = consumer.moduleFormat === 'esm';
    const specifiers = (consumer.subpaths ?? ['.']).map((s) =>
      s === '.' ? pkg.name : `${pkg.name}/${s.replace(/^\.\//, '')}`,
    );
    const consumeFile = isEsm ? 'consume.mjs' : 'consume.cjs';
    writeFileSync(
      join(tmp, consumeFile),
      specifiers.map((s) => (isEsm ? `await import("${s}");` : `require("${s}");`)).join('\n') +
        '\nconsole.log("runtime import ok");\n',
    );
    try {
      run('node', [consumeFile], tmp);
      log(
        `✅ runtime ${isEsm ? 'import' : 'require'} of ${specifiers.length === 1 ? 'the package entry' : 'root + subpaths'} passed`,
      );
    } catch (e) {
      const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
      report(['runtime import FAILED against the packed tarball:\n' + out]);
    }

    // 8. Execute every published command-line entry point.
    //
    // Loading the library entry does not exercise the bins, and a bin can depend on
    // packages the library never imports. If such a dependency is missing from
    // `dependencies` it is absent from a real install, so the bin fails at startup
    // while every other check still passes. Running each bin also confirms it
    // reports the package version, which is otherwise only observable at runtime.
    const bins = Object.keys(pkg.bin ?? {});
    if (bins.length) {
      const binFailures = [];
      for (const bin of bins) {
        try {
          const out = run(join(tmp, 'node_modules', '.bin', bin), ['--version'], tmp)
            .toString()
            .trim();
          if (out !== pkg.version) {
            binFailures.push(`bin '${bin}' reported version "${out}", expected "${pkg.version}"`);
          }
        } catch (e) {
          const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
          binFailures.push(`bin '${bin}' failed to run from a real install:\n${out}`);
        }
      }
      report(binFailures);
      if (binFailures.length === 0) {
        log(
          `✅ all ${bins.length} command-line entry point(s) run from a real install and report ${pkg.version}`,
        );
      }
    }
  } finally {
    rmSync(tgz, { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failed) {
    error(`${pkg.name} is NOT publishable.`);
    return false;
  }
  log(`✅ ${pkg.name} is publishable (no @atum-labs deps; consumer types compile).`);
  return true;
}

/** Escape a literal so it can be embedded in a RegExp; package names may contain `.`. */
function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the throwaway consumer source. Importing the same symbols the README
 * examples use means a broken public surface fails the guard.
 */
function renderConsumerSource(pkgName, consumer) {
  const importLines = [];
  const voidLines = [];
  for (const [subpath, names] of Object.entries(consumer.imports)) {
    const specifier = subpath === '.' ? pkgName : `${pkgName}/${subpath.replace(/^\.\//, '')}`;
    // The same symbol can be exported from several subpaths (mppx re-exports
    // registerClient from both the root and ./client), so alias per subpath to
    // keep the generated module free of duplicate bindings.
    const suffix = subpath === '.' ? '' : `_${subpath.replace(/[^a-zA-Z0-9]/g, '')}`;
    importLines.push(
      `import { ${names.map((n) => (suffix ? `${n} as ${n}${suffix}` : n)).join(', ')} } from '${specifier}';`,
    );
    voidLines.push(...names.map((n) => `void ${n}${suffix};`));
  }
  return [...importLines, ...voidLines].join('\n') + '\n';
}
