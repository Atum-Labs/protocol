import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  filterChangedFiles,
  selectSdks,
  entryAdded,
  escapeHatch,
  listProjects,
} from '../src/changelog-pr.mjs';
import { tempDir, writeFile, cleanupAll } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');
const bin = join(here, '../bin/publish-guard.mjs');

afterAll(cleanupAll);

const PGC = 'schemas/apis/payment-gateway/v1/bindings/typescript/client';
const MPPX = 'schemas/apis/payment-gateway/v1/bindings/typescript/mppx-atum-escrow';
const X402 = 'schemas/apis/x402/v1/bindings/x402-atum-escrow';
const SDK_DIRS = [PGC, MPPX, X402];

const HEADER = `# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`;
const changelog = (body) => `${HEADER}\n${body}`;

describe('filterChangedFiles', () => {
  const filter = (files, versionOnly = []) =>
    filterChangedFiles(files, {
      sdkDirs: SDK_DIRS,
      isVersionOnly: (p) => versionOnly.includes(p),
    });

  it('drops tooling, tests, test configs and Go sources', () => {
    expect(
      filter([
        'tooling/publish-guard/src/check.mjs',
        `${PGC}/src/client.test.ts`,
        `${PGC}/src/client.spec.ts`,
        `${PGC}/jest.config.js`,
        `${PGC}/tsconfig.test.json`,
        `${MPPX}/vitest.config.ts`,
        'contracts/evm/source/test/Escrow.t.sol',
        'contracts/svm/source/tests/escrow.ts',
        `${X402}/src/__tests__/fixture.ts`,
        'schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/senderauth/verify.go',
        'schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/go.mod',
        'schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/go.sum',
      ]),
    ).toEqual([]);
  });

  it('keeps sources, configs and a dependency change', () => {
    const files = [
      `${PGC}/src/client.ts`,
      `${PGC}/src/testing.ts`,
      `${PGC}/tsup.config.ts`,
      `${PGC}/package.json`,
      'schemas/declarations/PaymentRequest/v1/conformance/vectors.json',
    ];
    expect(filter(files)).toEqual(files);
  });

  it('drops the publishable packages’ changelogs and version-only package.json edits', () => {
    expect(
      filter(
        [`${PGC}/CHANGELOG.md`, `${PGC}/package.json`, `${MPPX}/CHANGELOG.md`],
        [`${PGC}/package.json`],
      ),
    ).toEqual([]);
  });

  it('keeps a changelog that belongs to no publishable package', () => {
    const file = 'schemas/apis/counterparty-gateway/v1/webhook/CHANGELOG.md';
    expect(filter([file])).toEqual([file]);
  });
});

describe('selectSdks', () => {
  // Mirrors the real edges: mppx bundles pgc, every SDK bundles the encoders and
  // sender-auth, and sender-auth's package sits inside schema-declarations' directory.
  const projects = [
    { name: 'root', dir: '', workspaceDeps: [] },
    { name: 'km-core', dir: 'key-management/common/typescript', workspaceDeps: [] },
    { name: 'evm', dir: 'contracts/evm/bindings/typescript/escrow-encoding', workspaceDeps: [] },
    { name: 'decls', dir: 'schemas/declarations', workspaceDeps: [] },
    {
      name: 'sender-auth',
      dir: 'schemas/declarations/PaymentRequest/v1/bindings/typescript/sender-auth',
      workspaceDeps: ['evm'],
    },
    { name: 'pgc', dir: PGC, workspaceDeps: ['km-core', 'evm', 'sender-auth', 'decls'] },
    { name: 'mppx', dir: MPPX, workspaceDeps: ['pgc', 'evm', 'sender-auth', 'decls'] },
    { name: 'x402', dir: X402, workspaceDeps: ['evm', 'sender-auth', 'decls'] },
  ];
  const select = (...files) =>
    selectSdks({ files, projects, sdkNames: ['pgc', 'mppx', 'x402'] }).map((s) => s.name);

  it('selects the dependents of a changed library, transitively', () => {
    expect(select('key-management/common/typescript/src/signer.ts')).toEqual(['mppx', 'pgc']);
  });

  it('selects every SDK for a shared encoder change', () => {
    expect(select('contracts/evm/bindings/typescript/escrow-encoding/src/index.ts')).toEqual([
      'mppx',
      'pgc',
      'x402',
    ]);
  });

  it('lets the deepest project own a file', () => {
    const decls = selectSdks({
      files: ['schemas/declarations/PaymentRequest/v1/bindings/typescript/sender-auth/src/a.ts'],
      projects: projects.map((p) => (p.name === 'x402' ? { ...p, workspaceDeps: ['decls'] } : p)),
      sdkNames: ['x402'],
    });
    // x402 depends on decls only here; a sender-auth file must not reach it through decls.
    expect(decls).toEqual([]);
  });

  it('selects only the owner for README and docs changes', () => {
    expect(select(`${PGC}/README.md`)).toEqual(['pgc']);
    expect(select(`${PGC}/docs/guide.html`)).toEqual(['pgc']);
    expect(select('key-management/common/typescript/README.md')).toEqual([]);
  });

  it('selects every SDK for a change to the workspace file', () => {
    expect(select('pnpm-workspace.yaml')).toEqual(['mppx', 'pgc', 'x402']);
  });

  it('selects nothing for a file the workspace root owns', () => {
    expect(select('schemas/apis/payment-gateway/v1/openapi.yaml', 'Makefile')).toEqual([]);
  });

  it('selects the importer of a file outside every package, and its dependents', () => {
    const withInput = projects.map((p) =>
      p.name === 'pgc' ? { ...p, inputs: ['shared/schema'] } : p,
    );
    const pick = (file) =>
      selectSdks({ files: [file], projects: withInput, sdkNames: ['pgc', 'mppx', 'x402'] }).map(
        (s) => s.name,
      );
    expect(pick('shared/schema.json')).toEqual(['mppx', 'pgc']);
    expect(pick('shared/schema/index.ts')).toEqual(['mppx', 'pgc']);
    expect(pick('shared/schema2.json')).toEqual([]);
  });

  it('reports the first file that selected each SDK', () => {
    expect(
      selectSdks({
        files: [`${PGC}/src/a.ts`, 'contracts/evm/bindings/typescript/escrow-encoding/src/b.ts'],
        projects,
        sdkNames: ['pgc', 'mppx', 'x402'],
      }),
    ).toEqual([
      { name: 'mppx', dir: MPPX, via: `${PGC}/src/a.ts` },
      { name: 'pgc', dir: PGC, via: `${PGC}/src/a.ts` },
      {
        name: 'x402',
        dir: X402,
        via: 'contracts/evm/bindings/typescript/escrow-encoding/src/b.ts',
      },
    ]);
  });
});

describe('selectSdks on this repository’s workspace', () => {
  const projects = listProjects(repoRoot);
  const sdkNames = projects.filter((p) => p.sdk).map((p) => p.name);
  const select = (file) => selectSdks({ files: [file], projects, sdkNames }).map((s) => s.name);

  it('finds the three publishable packages', () => {
    expect(sdkNames.sort()).toEqual([
      '@atum-labs/mppx-atum-escrow',
      '@atum-labs/payment-gateway-client',
      '@atum-labs/x402-atum-escrow',
    ]);
  });

  it.each([
    [
      'key-management/common/typescript/src/index.ts',
      ['@atum-labs/mppx-atum-escrow', '@atum-labs/payment-gateway-client'],
    ],
    [
      'contracts/evm/bindings/typescript/escrow-encoding/src/index.ts',
      [
        '@atum-labs/mppx-atum-escrow',
        '@atum-labs/payment-gateway-client',
        '@atum-labs/x402-atum-escrow',
      ],
    ],
    [`${PGC}/src/index.ts`, ['@atum-labs/mppx-atum-escrow', '@atum-labs/payment-gateway-client']],
    [`${PGC}/README.md`, ['@atum-labs/payment-gateway-client']],
    [`${X402}/src/index.ts`, ['@atum-labs/x402-atum-escrow']],
    ['schemas/apis/x402/v1/payload/schema.json', ['@atum-labs/x402-atum-escrow']],
    ['schemas/apis/x402/v1/extra/schema.json', ['@atum-labs/x402-atum-escrow']],
    ['schemas/apis/payment-gateway/v1/openapi.yaml', []],
  ])('%s selects %j', (file, expected) => {
    expect(select(file)).toEqual(expected);
  });
});

describe('entryAdded', () => {
  const BASE = changelog(
    '## [Unreleased]\n\n### Added\n- Existing.\n\n## [1.0.0] - 2026-07-21\n\n### Fixed\n- Old.\n',
  );

  it('is true for a new line under [Unreleased]', () => {
    expect(entryAdded(BASE, BASE.replace('- Existing.\n', '- Existing.\n- New.\n'))).toBe(true);
  });

  it('is true when an existing line is duplicated', () => {
    expect(entryAdded(BASE, BASE.replace('- Existing.\n', '- Existing.\n- Existing.\n'))).toBe(
      true,
    );
  });

  it('is false for a reworded heading only', () => {
    expect(entryAdded(BASE, BASE.replace('### Added', '### Changed'))).toBe(false);
  });

  it('is false for a whitespace-only edit', () => {
    expect(entryAdded(BASE, BASE.replace('- Existing.', '  - Existing.   '))).toBe(false);
  });

  it('is false when an entry is only deleted', () => {
    expect(entryAdded(BASE, BASE.replace('### Added\n- Existing.\n\n', ''))).toBe(false);
  });

  it('is false for a new line in an existing version section', () => {
    expect(entryAdded(BASE, BASE.replace('- Old.\n', '- Old.\n- Backfilled.\n'))).toBe(false);
  });

  it('is false for a line under a ### before the first ##', () => {
    const head = BASE.replace('## [Unreleased]', '### Added\n- Stray.\n\n## [Unreleased]');
    expect(entryAdded(BASE, head)).toBe(false);
  });

  it('is true for a new dated section (a release)', () => {
    const head = BASE.replace(
      '## [Unreleased]\n\n### Added\n- Existing.\n',
      '## [Unreleased]\n\n## [1.1.0] - 2026-08-01\n\n### Added\n- Existing.\n',
    );
    expect(entryAdded(BASE, head)).toBe(true);
  });

  it('is false for a new section with a malformed version heading', () => {
    const head = BASE.replace(
      '## [1.0.0] - 2026-07-21',
      '## [1.2] - 2026-1-5\n\n### Added\n- y\n\n## [1.0.0] - 2026-07-21',
    );
    expect(entryAdded(BASE, head)).toBe(false);
  });

  it('treats a missing base as empty', () => {
    expect(entryAdded(null, BASE)).toBe(true);
    expect(entryAdded(null, changelog('## [Unreleased]\n'))).toBe(false);
  });
});

describe('escapeHatch', () => {
  it('is not used without the label', () => {
    expect(escapeHatch({ labels: ['other'], body: 'Changelog: none — docs only' })).toEqual({
      used: false,
      ok: true,
    });
  });

  it.each(['—', '–', '-'])('accepts the label with a reason line using %s', (dash) => {
    expect(
      escapeHatch({
        labels: ['changelog: none'],
        body: `## Why\r\nText.\r\n\r\nChangelog: none ${dash} test-only refactor\r\n`,
      }),
    ).toEqual({ used: true, ok: true, reason: 'test-only refactor' });
  });

  it('fails the label without a reason line', () => {
    expect(escapeHatch({ labels: ['changelog: none'], body: 'Changelog: none' })).toEqual({
      used: true,
      ok: false,
    });
    expect(escapeHatch({ labels: ['changelog: none'], body: null })).toEqual({
      used: true,
      ok: false,
    });
  });

  it('does not accept the line inside other text', () => {
    expect(
      escapeHatch({ labels: ['changelog: none'], body: '<!-- Changelog: none — reason -->' }).ok,
    ).toBe(false);
  });
});

describe('changelog pr-check CLI', () => {
  // Isolated from the user's git config (signing, hooks, default branch).
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const VALID = changelog('## [Unreleased]\n\n## [1.0.0] - 2026-07-21\n\n### Added\n- First.\n');
  const sdk = (name, deps = {}) => ({
    [`sdks/${name}/package.json`]: JSON.stringify(
      { name, version: '1.0.0', devDependencies: deps },
      null,
      2,
    ),
    [`sdks/${name}/publish-guard.config.mjs`]: 'export default {};\n',
    [`sdks/${name}/CHANGELOG.md`]: VALID,
    [`sdks/${name}/src/index.ts`]: 'export {};\n',
  });

  /** A git repo holding a small pnpm workspace: sdk `a` bundles lib `core`, sdk `b` does not. */
  function workspace() {
    const root = tempDir();
    const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
    const commit = (files) => {
      for (const [rel, contents] of Object.entries(files)) {
        if (contents === null) rmSync(join(root, rel));
        else writeFile(root, rel, contents);
      }
      git('add', '-A');
      git('commit', '-q', '-m', 'change');
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q', '-b', 'main');
    const base = commit({
      'package.json': '{ "name": "root", "private": true }\n',
      'pnpm-workspace.yaml': "packages:\n  - 'libs/*'\n  - 'sdks/*'\n",
      'libs/core/package.json': '{ "name": "core" }\n',
      'libs/core/src/index.ts': 'export {};\n',
      ...sdk('a', { core: 'workspace:*' }),
      ...sdk('b'),
    });
    const run = (args, extraEnv = {}) => {
      try {
        const out = execFileSync('node', [bin, 'changelog', 'pr-check', ...args], {
          cwd: root,
          env: { ...env, ...extraEnv },
          encoding: 'utf8',
          stdio: 'pipe',
        });
        return { code: 0, out };
      } catch (e) {
        return { code: e.status, out: `${e.stdout}${e.stderr}` };
      }
    };
    return { root, git, commit, base, run };
  }

  it('fails naming the SDK and the file that selected it', () => {
    const w = workspace();
    w.commit({ 'libs/core/src/index.ts': 'export const x = 1;\n' });
    const { code, out } = w.run(['--base', w.base]);
    expect(code).toBe(1);
    expect(out).toContain('✗ a (via libs/core/src/index.ts)');
    expect(out).toContain('sdks/a/CHANGELOG.md');
    expect(out).not.toMatch(/\bb \(via/);
  });

  it('passes once the selected SDK has an entry', () => {
    const w = workspace();
    w.commit({
      'libs/core/src/index.ts': 'export const x = 1;\n',
      'sdks/a/CHANGELOG.md': VALID.replace(
        '## [Unreleased]\n',
        '## [Unreleased]\n\n### Added\n- x.\n',
      ),
    });
    const { code, out } = w.run(['--base', w.base]);
    expect(code).toBe(0);
    expect(out).toContain('✓ a (via libs/core/src/index.ts): entry added');
  });

  it('passes a release: version bump plus promoted changelog, even with a dependent SDK', () => {
    const w = workspace();
    const base = w.commit({
      'sdks/b/package.json': JSON.stringify(
        { name: 'b', version: '1.0.0', devDependencies: { a: 'workspace:*' } },
        null,
        2,
      ),
    });
    w.commit({
      'sdks/a/package.json': JSON.stringify(
        { name: 'a', version: '1.1.0', devDependencies: { core: 'workspace:*' } },
        null,
        2,
      ),
      'sdks/a/CHANGELOG.md': VALID.replace(
        '## [Unreleased]\n',
        '## [Unreleased]\n\n## [1.1.0] - 2026-08-01\n\n### Added\n- x.\n',
      ),
    });
    const { code, out } = w.run(['--base', base]);
    expect(code).toBe(0);
    expect(out).toContain('Release a 1.1.0: notes ok');
    expect(out).toContain('No publishable package changed.');
  });

  it('passes a release that carries newer [Unreleased] entries merged from main', () => {
    const w = workspace();
    w.commit({
      'sdks/a/package.json': JSON.stringify(
        { name: 'a', version: '1.1.0', devDependencies: { core: 'workspace:*' } },
        null,
        2,
      ),
      'sdks/a/CHANGELOG.md': VALID.replace(
        '## [Unreleased]\n',
        '## [Unreleased]\n\n### Fixed\n- Later.\n\n## [1.1.0] - 2026-08-01\n\n### Added\n- x.\n',
      ),
    });
    const { code, out } = w.run(['--base', w.base]);
    expect(code).toBe(0);
    expect(out).toContain('Release a 1.1.0: notes ok');
  });

  it('fails a version bump whose notes are still under [Unreleased]', () => {
    const w = workspace();
    w.commit({
      'sdks/a/package.json': JSON.stringify(
        { name: 'a', version: '1.1.0', devDependencies: { core: 'workspace:*' } },
        null,
        2,
      ),
      'sdks/a/CHANGELOG.md': VALID.replace(
        '## [Unreleased]\n',
        '## [Unreleased]\n\n### Added\n- x.\n',
      ),
    });
    const { code, out } = w.run(['--base', w.base]);
    expect(code).toBe(1);
    expect(out).toContain('✗ a 1.1.0: sdks/a/CHANGELOG.md:6: no "## [1.1.0] - YYYY-MM-DD" section');
  });

  it('fails an unpromoted version bump even with the changelog: none label and reason', () => {
    const w = workspace();
    w.commit({
      'libs/core/src/index.ts': 'export const x = 1;\n',
      'sdks/a/package.json': JSON.stringify(
        { name: 'a', version: '1.1.0', devDependencies: { core: 'workspace:*' } },
        null,
        2,
      ),
    });
    const { code, out } = w.run(['--base', w.base], {
      PR_LABELS: '["changelog: none"]',
      PR_BODY: 'Changelog: none — internal only',
    });
    expect(code).toBe(1);
    expect(out).toContain('Entries not required (label "changelog: none")');
    expect(out).toContain('✗ a 1.1.0:');
  });

  it('does not treat a new SDK as a version bump', () => {
    const w = workspace();
    w.commit({
      ...sdk('c'),
      // No "## [0.1.0]" section: a bump check would fail it.
      'sdks/c/package.json': JSON.stringify({ name: 'c', version: '0.1.0' }, null, 2),
      'sdks/c/CHANGELOG.md': VALID.replace(
        '## [Unreleased]\n',
        '## [Unreleased]\n\n### Added\n- x.\n',
      ),
    });
    const { code, out } = w.run(['--base', w.base]);
    expect(code).toBe(0);
    expect(out).not.toMatch(/✗ c /);
    expect(out).not.toContain('Release c');
  });

  it('fails the SDK without an entry when one change selects two SDKs', () => {
    const w = workspace();
    const base = w.commit(sdk('c', { core: 'workspace:*' }));
    w.commit({
      'libs/core/src/index.ts': 'export const x = 1;\n',
      'sdks/a/CHANGELOG.md': VALID.replace(
        '## [Unreleased]\n',
        '## [Unreleased]\n\n### Added\n- x.\n',
      ),
    });
    const { code, out } = w.run(['--base', base]);
    expect(code).toBe(1);
    expect(out).toContain('✓ a (via libs/core/src/index.ts): entry added');
    expect(out).toContain('✗ c (via libs/core/src/index.ts): no new line');
  });

  it('selects the SDK whose src imports a changed file outside every package', () => {
    const w = workspace();
    const base = w.commit({
      'shared/schema.json': '{}\n',
      'sdks/b/src/index.ts':
        "import schema from '../../../shared/schema.json';\nexport { schema };\n",
      'sdks/a/src/index.test.ts': "import '../../../shared/other.json';\n",
      'shared/other.json': '{}\n',
    });
    w.commit({ 'shared/schema.json': '{ "type": "object" }\n', 'shared/other.json': '[]\n' });
    const { code, out } = w.run(['--base', base]);
    expect(code).toBe(1);
    expect(out).toContain('✗ b (via shared/schema.json)');
    expect(out).not.toMatch(/\ba \(via/);
  });

  it.each([
    ['value.js', 'value.ts'],
    ['value.js', 'value.tsx'],
    ['value.js', 'value.d.ts'],
    ['value.jsx', 'value.tsx'],
    ['value.mjs', 'value.mts'],
    ['value.cjs', 'value.cts'],
  ])('selects the SDK that imports shared/%s when shared/%s changes', (spec, file) => {
    const w = workspace();
    const base = w.commit({
      [`shared/${file}`]: 'export const v = 1;\n',
      'sdks/b/src/index.ts': `export * from '../../../shared/${spec}';\n`,
    });
    w.commit({ [`shared/${file}`]: 'export const v = 2;\n' });
    const { code, out } = w.run(['--base', base]);
    expect(code).toBe(1);
    expect(out).toContain(`✗ b (via shared/${file})`);
  });

  it('reads the package graph from --head, not from the checkout', () => {
    const w = workspace();
    const head = w.commit({ 'libs/core/src/index.ts': 'export const x = 1;\n' });
    // The checkout moves on: a no longer depends on core, and its config is deleted locally.
    w.commit(sdk('a'));
    rmSync(join(w.root, 'sdks/a/publish-guard.config.mjs'));
    const { code, out } = w.run(['--base', w.base, '--head', head]);
    expect(code).toBe(1);
    expect(out).toContain('✗ a (via libs/core/src/index.ts)');
  });

  it('selects the owner for a dependency change in package.json', () => {
    const w = workspace();
    w.commit({
      'sdks/b/package.json': JSON.stringify(
        { name: 'b', version: '1.0.0', dependencies: { viem: '^2.0.0' } },
        null,
        2,
      ),
    });
    const { code, out } = w.run(['--base', w.base]);
    expect(code).toBe(1);
    expect(out).toContain('✗ b (via sdks/b/package.json)');
  });

  it('counts both paths of a rename', () => {
    const w = workspace();
    w.commit({ 'sdks/b/src/index.ts': null, 'libs/core/src/moved.ts': 'export {};\n' });
    const { out } = w.run(['--base', w.base]);
    expect(out).toContain('✗ a (via libs/core/src/moved.ts)');
    expect(out).toContain('✗ b (via sdks/b/src/index.ts)');
  });

  it('passes with the label and a reason, and prints the reason', () => {
    const w = workspace();
    w.commit({ 'libs/core/src/index.ts': 'export const x = 1;\n' });
    const { code, out } = w.run(['--base', w.base], {
      PR_LABELS: '["changelog: none"]',
      PR_BODY: 'Changelog: none — internal refactor',
    });
    expect(code).toBe(0);
    expect(out).toContain('internal refactor');
    expect(out).toContain('- a (via libs/core/src/index.ts)');
  });

  it('fails with the label but no reason line', () => {
    const w = workspace();
    w.commit({ 'libs/core/src/index.ts': 'export const x = 1;\n' });
    const { code, out } = w.run(['--base', w.base], { PR_LABELS: '["changelog: none"]' });
    expect(code).toBe(1);
    expect(out).toContain('Changelog: none — <reason>');
  });

  it('fails a malformed changelog even when nothing is selected', () => {
    const w = workspace();
    w.commit({
      'sdks/b/CHANGELOG.md': VALID.replace(
        '## [Unreleased]\n',
        '## [Unreleased]\n\n### Notes\n- x\n',
      ),
    });
    const { code, out } = w.run(['--base', w.base]);
    expect(code).toBe(1);
    expect(out).toContain('sdks/b/CHANGELOG.md:');
    expect(out).toContain('unknown heading "### Notes"');
  });

  it('compares against the merge base, not the base tip', () => {
    const w = workspace();
    // The branch starts while `- Pending.` waits under [Unreleased] ...
    const start = w.commit({
      'sdks/a/CHANGELOG.md': VALID.replace(
        '## [Unreleased]\n',
        '## [Unreleased]\n\n### Added\n- Pending.\n',
      ),
    });
    w.git('switch', '-q', '-c', 'feature');
    w.commit({ 'libs/core/src/index.ts': 'export const x = 1;\n' });
    // ... then main releases it. The branch still adds no entry of its own.
    w.git('switch', '-q', 'main');
    const tip = w.commit({
      'sdks/a/CHANGELOG.md': VALID.replace(
        '## [Unreleased]\n',
        '## [Unreleased]\n\n## [1.1.0] - 2026-08-01\n\n### Added\n- Pending.\n',
      ),
    });
    expect(tip).not.toBe(start);
    const { code } = w.run(['--base', 'main', '--head', 'feature']);
    expect(code).toBe(1);
  });

  it('still checks an SDK whose config this change deletes', () => {
    const w = workspace();
    w.commit({ 'sdks/b/publish-guard.config.mjs': null });
    const { code, out } = w.run(['--base', w.base]);
    expect(code).toBe(1);
    expect(out).toContain('✗ b (via sdks/b/publish-guard.config.mjs)');
  });

  it('fails when an SDK changelog is deleted', () => {
    const w = workspace();
    w.commit({ 'sdks/b/CHANGELOG.md': null });
    const { code, out } = w.run(['--base', w.base]);
    expect(code).toBe(1);
    expect(out).toContain('✗ sdks/b/CHANGELOG.md: not found');
  });

  it('prints a file name with a newline on one line', () => {
    const w = workspace();
    w.commit({ 'libs/core/src/a\n::error::b.ts': 'export {};\n' });
    const { out } = w.run(['--base', w.base]);
    expect(out).toContain('via libs/core/src/a\\n::error::b.ts');
    expect(out).not.toMatch(/^::/m);
  });

  it('fails loudly when there is no merge base', () => {
    const w = workspace();
    w.git('switch', '-q', '--orphan', 'other');
    const orphan = w.commit({ 'unrelated.txt': 'x\n' });
    const { code, out } = w.run(['--base', orphan, '--head', 'main']);
    expect(code).toBe(1);
    expect(out).toContain('no merge base');
  });

  it('fails loudly for an unknown base', () => {
    const w = workspace();
    const { code, out } = w.run(['--base', 'deadbeef']);
    expect(code).toBe(1);
    expect(out).toContain('"deadbeef" is not a commit');
  });

  it('fails loudly when the workspace has no publishable package', () => {
    const w = workspace();
    const base = w.commit({
      'sdks/a/publish-guard.config.mjs': null,
      'sdks/b/publish-guard.config.mjs': null,
    });
    w.commit({ 'libs/core/src/index.ts': 'export const x = 1;\n' });
    const { code, out } = w.run(['--base', base]);
    expect(code).toBe(1);
    expect(out).toContain('no publishable packages');
  });

  it('rejects malformed PR_LABELS', () => {
    const w = workspace();
    const { code, out } = w.run(['--base', w.base], { PR_LABELS: '"changelog: none"' });
    expect(code).toBe(1);
    expect(out).toContain('PR_LABELS must be a JSON array');
  });

  it('exits 2 without --base', () => {
    expect(workspace().run([]).code).toBe(2);
  });
});
