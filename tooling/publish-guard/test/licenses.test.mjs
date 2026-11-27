import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import {
  checkInlinedLicenses,
  checkSiblingDeps,
  checkDistSpecifiers,
  checkTarballManifest,
} from '../src/check.mjs';
import { scanInlined } from '../src/inlined.mjs';
import { makePackage, makePnpmStore, cleanupAll, stamped, inlinedRef } from './helpers.mjs';

afterAll(cleanupAll);

describe('scanInlined', () => {
  it('discovers inlined packages from the pnpm store paths esbuild leaves behind', () => {
    const { distDir } = makePackage({
      dist: {
        'index.js': stamped(inlinedRef('axios', 'axios@1.13.2') + inlinedRef('bs58', 'bs58@6.0.0')),
      },
    });
    expect([...scanInlined(distDir).keys()].sort()).toEqual(['axios', 'bs58']);
  });

  it('ignores @atum-labs siblings — those are ours, not third-party attribution', () => {
    const { distDir } = makePackage({
      dist: { 'index.js': stamped(inlinedRef('@atum-labs/km-core', '@atum-labs+km-core@1.0.0')) },
    });
    expect(scanInlined(distDir).size).toBe(0);
  });

  it('walks nested dist directories (dist/cli/*.js carry their own inlined set)', () => {
    const { distDir } = makePackage({
      dist: {
        'index.js': stamped(inlinedRef('axios', 'axios@1.13.2')),
        'cli/send-payment.js': stamped(inlinedRef('commander', 'commander@12.0.0')),
      },
    });
    expect([...scanInlined(distDir).keys()].sort()).toEqual(['axios', 'commander']);
  });

  it('is not affected by regex state from a previous call', () => {
    const { distDir } = makePackage({
      dist: { 'index.js': stamped(inlinedRef('axios', 'axios@1.13.2')) },
    });
    expect([...scanInlined(distDir).keys()]).toEqual(['axios']);
    expect([...scanInlined(distDir).keys()]).toEqual(['axios']);
  });
});

describe('checkInlinedLicenses', () => {
  const notices = (names) => names.map((n) => `${n}  1.0.0   (MIT)\n\nlicense text\n`).join('\n');

  it('passes for permissive, fully attributed inlined packages', () => {
    const { root, distDir } = makePackage({
      dist: { 'index.js': stamped(inlinedRef('axios', 'axios@1.13.2')) },
      notices: notices(['axios']),
    });
    const { store } = makePnpmStore([{ name: 'axios', id: 'axios@1.13.2', license: 'MIT' }]);
    const { failures, inlinedCount } = checkInlinedLicenses({
      distDir,
      pnpmStore: store,
      noticesPath: join(root, 'THIRD-PARTY-NOTICES.txt'),
    });
    expect(failures).toEqual([]);
    expect(inlinedCount).toBe(1);
  });

  it('fails on an inlined copyleft dependency', () => {
    const { root, distDir } = makePackage({
      dist: { 'index.js': stamped(inlinedRef('rpc-websockets', 'rpc-websockets@7.0.0')) },
      notices: notices(['rpc-websockets']),
    });
    const { store } = makePnpmStore([
      { name: 'rpc-websockets', id: 'rpc-websockets@7.0.0', license: 'LGPL-3.0' },
    ]);
    const { failures } = checkInlinedLicenses({
      distDir,
      pnpmStore: store,
      noticesPath: join(root, 'THIRD-PARTY-NOTICES.txt'),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('copyleft component inlined into the tarball');
    expect(failures[0]).toContain('rpc-websockets');
  });

  it.each(['GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'MPL-2.0', 'EUPL-1.2', 'CDDL-1.0', 'EPL-2.0'])(
    'rejects %s as copyleft',
    (license) => {
      const { root, distDir } = makePackage({
        dist: { 'index.js': stamped(inlinedRef('thing', 'thing@1.0.0')) },
        notices: notices(['thing']),
      });
      const { store } = makePnpmStore([{ name: 'thing', id: 'thing@1.0.0', license }]);
      const { failures } = checkInlinedLicenses({
        distDir,
        pnpmStore: store,
        noticesPath: join(root, 'THIRD-PARTY-NOTICES.txt'),
      });
      expect(failures.some((f) => f.includes('copyleft'))).toBe(true);
    },
  );

  it('fails when an inlined package is missing from the notices', () => {
    const { root, distDir } = makePackage({
      dist: {
        'index.js': stamped(inlinedRef('axios', 'axios@1.13.2') + inlinedRef('bs58', 'bs58@6.0.0')),
      },
      notices: notices(['axios']), // bs58 attribution missing
    });
    const { store } = makePnpmStore([
      { name: 'axios', id: 'axios@1.13.2' },
      { name: 'bs58', id: 'bs58@6.0.0' },
    ]);
    const { failures } = checkInlinedLicenses({
      distDir,
      pnpmStore: store,
      noticesPath: join(root, 'THIRD-PARTY-NOTICES.txt'),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('missing attribution');
    expect(failures[0]).toContain('bs58');
  });

  it('fails when the notices attribute an inlined package at another version', () => {
    const { root, distDir } = makePackage({
      dist: { 'index.js': stamped(inlinedRef('follow-redirects', 'follow-redirects@1.16.3')) },
      notices: 'follow-redirects  1.16.0   (MIT)\n\nlicense text\n',
    });
    const { store } = makePnpmStore([
      { name: 'follow-redirects', id: 'follow-redirects@1.16.3', version: '1.16.3' },
    ]);
    const { failures } = checkInlinedLicenses({
      distDir,
      pnpmStore: store,
      noticesPath: join(root, 'THIRD-PARTY-NOTICES.txt'),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('follow-redirects@1.16.3');
    expect(failures[0]).toContain('pnpm gen:notices');
  });

  it('fails when the notices file is absent entirely', () => {
    const { root, distDir } = makePackage({
      dist: { 'index.js': stamped(inlinedRef('axios', 'axios@1.13.2')) },
    });
    const { store } = makePnpmStore([{ name: 'axios', id: 'axios@1.13.2' }]);
    const { failures } = checkInlinedLicenses({
      distDir,
      pnpmStore: store,
      noticesPath: join(root, 'THIRD-PARTY-NOTICES.txt'),
    });
    expect(failures.some((f) => f.includes('THIRD-PARTY-NOTICES.txt not found'))).toBe(true);
  });

  // The scan reads package paths out of unminified output. A minified build strips
  // them, which would make every license check pass without inspecting anything.
  it('fails closed when no inlined package is detected (blind scan)', () => {
    const { root, distDir } = makePackage({
      dist: { 'index.js': stamped('/* minified, no store paths */\n') },
      notices: '',
    });
    const { failures } = checkInlinedLicenses({
      distDir,
      pnpmStore: '/nonexistent',
      noticesPath: join(root, 'THIRD-PARTY-NOTICES.txt'),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('leaving the copyleft/attribution scan blind');
  });

  it('fails closed when a bundled package cannot be resolved in the store', () => {
    const { root, distDir } = makePackage({
      dist: { 'index.js': stamped(inlinedRef('ghost', 'ghost@9.9.9')) },
      notices: notices(['ghost']),
    });
    const { store } = makePnpmStore([]); // store exists but holds nothing
    const { failures } = checkInlinedLicenses({
      distDir,
      pnpmStore: store,
      noticesPath: join(root, 'THIRD-PARTY-NOTICES.txt'),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('cannot resolve its license');
  });
});

describe('checkSiblingDeps', () => {
  it('passes when siblings are dev-only', () => {
    expect(
      checkSiblingDeps({
        dependencies: { axios: '1.13.2' },
        devDependencies: { '@atum-labs/km-core': 'workspace:*' },
      }),
    ).toEqual([]);
  });

  it('fails when a sibling is a runtime dependency', () => {
    const failures = checkSiblingDeps({ dependencies: { '@atum-labs/km-core': 'workspace:*' } });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('must be bundled, not a runtime dep');
  });
});

describe('checkDistSpecifiers', () => {
  it('fails when a sibling import survives in dist (bundling leaked)', () => {
    const { root, distDir } = makePackage({
      manifest: { name: '@atum-labs/fixture' },
      dist: { 'index.js': stamped(`const x = require("@atum-labs/km-core");\n`) },
    });
    const failures = checkDistSpecifiers({ distDir, pkgName: '@atum-labs/fixture', pkgRoot: root });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('bundling leaked');
  });

  it('allows a self-reference (JSDoc @example blocks name the package itself)', () => {
    const { root, distDir } = makePackage({
      manifest: { name: '@atum-labs/fixture' },
      dist: {
        'index.js': stamped(
          `// import { x } from "@atum-labs/fixture";\nrequire("@atum-labs/fixture");\n`,
        ),
      },
    });
    expect(checkDistSpecifiers({ distDir, pkgName: '@atum-labs/fixture', pkgRoot: root })).toEqual(
      [],
    );
  });
});

describe('checkTarballManifest', () => {
  const pkg = { license: 'Apache-2.0' };
  const complete = [
    'LICENSE',
    'README.md',
    'THIRD-PARTY-NOTICES.txt',
    'package.json',
    'dist/index.js',
  ];

  it('passes for a complete, clean manifest', () => {
    expect(checkTarballManifest({ manifestFiles: complete, pkg })).toEqual([]);
  });

  it.each(['LICENSE', 'README.md', 'THIRD-PARTY-NOTICES.txt'])(
    'fails when %s is missing',
    (missing) => {
      const failures = checkTarballManifest({
        manifestFiles: complete.filter((f) => f !== missing),
        pkg,
      });
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain(`missing a required file: ${missing}`);
    },
  );

  it.each([
    'RELEASE-CHECKLIST.md',
    'SOURCE-HEADER.txt',
    'package-json-snippet.json',
    'README-LICENSE-NOTICE.md',
  ])('fails when the internal template %s leaks in', (leaked) => {
    const failures = checkTarballManifest({ manifestFiles: [...complete, leaked], pkg });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('internal-only template(s) leaked');
  });

  it('fails on an incorrect license field', () => {
    const failures = checkTarballManifest({ manifestFiles: complete, pkg: { license: 'MIT' } });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"license" must be "Apache-2.0"');
  });

  it('honors a package-specific required-files list', () => {
    const failures = checkTarballManifest({
      manifestFiles: complete,
      pkg,
      requiredFiles: [...complete, 'CHANGELOG.md'],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('CHANGELOG.md');
  });
});
