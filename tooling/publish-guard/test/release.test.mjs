import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReleaseCheck } from '../src/release.mjs';
import { tempDir, writeFile, cleanupAll } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '../bin/publish-guard.mjs');

afterAll(cleanupAll);

const HEADER = `# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`;
const PENDING = `${HEADER}
## [Unreleased]

### Added
- New thing.

## [0.7.0] - 2026-10-30

### Fixed
- Old fix.
`;
const PROMOTED = PENDING.replace(
  '## [Unreleased]\n',
  '## [Unreleased]\n\n## [0.8.0] - 2026-11-12\n',
);

function pkg(version, changelog) {
  const root = tempDir();
  writeFile(root, 'package.json', JSON.stringify({ name: '@scope/sdk', version }));
  if (changelog !== undefined) writeFile(root, 'CHANGELOG.md', changelog);
  return root;
}

const RELEASE = 'refs/heads/release/sdks-2026-11-14';
const RC = 'refs/heads/rc/sdk-0.8.0';

function check(pkgRoot, ref, distTag, packageName = 'sdk') {
  const out = [];
  const ok = runReleaseCheck({
    pkgRoot,
    ref,
    distTag,
    packageName,
    log: (m) => out.push(m),
    error: (m) => out.push(m),
  });
  return { ok, out: out.join('\n') };
}

describe('runReleaseCheck', () => {
  it('passes a final version from a release branch on latest', () => {
    const { ok, out } = check(pkg('0.8.0', PROMOTED), RELEASE, 'latest');
    expect(ok).toBe(true);
    expect(out).toContain(
      `✓ @scope/sdk@0.8.0 from ${RELEASE} on dist-tag "latest": release notes ok`,
    );
  });

  it('passes a prerelease from an rc branch on next', () => {
    expect(check(pkg('0.8.0-rc.1', PENDING), RC, 'next').ok).toBe(true);
  });

  it('passes a final version on next', () => {
    expect(check(pkg('0.8.0', PROMOTED), RELEASE, 'next').ok).toBe(true);
  });

  const FINAL = 'a final version: publish it from a branch named release/*';
  const PRE = 'a prerelease: publish it from a branch named rc/*';
  it.each([
    ['0.8.0', 'refs/heads/main', FINAL],
    ['0.8.0', RC, FINAL],
    ['0.8.0', 'refs/tags/release/x', FINAL],
    ['0.8.0', 'refs/heads/release', FINAL],
    ['0.8.0', 'refs/heads/release-x', FINAL],
    ['0.8.0', 'refs/heads/feature/release/x', FINAL],
    ['0.8.0', 'release/x', FINAL],
    ['0.8.0-rc.1', 'refs/heads/main', PRE],
    ['0.8.0-rc.1', RELEASE, PRE],
    ['0.8.0-rc.1', 'refs/tags/rc/x', PRE],
    ['0.8.0-rc.1', 'refs/heads/rc-x', PRE],
    ['0.8.0-rc.1', 'refs/heads/feature/rc/x', PRE],
    ['0.8.0-beta.1', 'refs/heads/main', PRE],
  ])('refuses %s from %s', (version, ref, message) => {
    const final = !version.includes('-');
    const { ok, out } = check(
      pkg(version, final ? PROMOTED : PENDING),
      ref,
      final ? 'latest' : 'next',
    );
    expect(ok).toBe(false);
    expect(out).toContain(`✗ @scope/sdk@${version} is ${message}, not ${ref}`);
  });

  it('refuses a prerelease on latest and still checks its notes', () => {
    const { ok, out } = check(pkg('0.8.0-rc.1', PROMOTED), RC, 'latest');
    expect(ok).toBe(false);
    expect(out).toContain(
      '✗ @scope/sdk@0.8.0-rc.1 is a prerelease: publish it with dist_tag next, not latest',
    );
    expect(out).toContain('"## [0.8.0]" already exists');
  });

  it('fails a final version whose notes are still under [Unreleased], naming path:line', () => {
    const root = pkg('0.8.0', PENDING);
    const { ok, out } = check(root, RELEASE, 'latest');
    expect(ok).toBe(false);
    expect(out).toContain(
      `✗ ${join(root, 'CHANGELOG.md')}:6: no "## [0.8.0] - YYYY-MM-DD" section`,
    );
  });

  it('refuses a final version while [Unreleased] still has notes', () => {
    const changelog = PROMOTED.replace(
      '## [Unreleased]\n',
      '## [Unreleased]\n\n### Fixed\n- Later.\n',
    );
    const root = pkg('0.8.0', changelog);
    const { ok, out } = check(root, RELEASE, 'latest');
    expect(ok).toBe(false);
    expect(out).toContain(':6: "## [Unreleased]" still has notes');
  });

  it.each([
    ['a final version', '0.8.0', PROMOTED, RELEASE, 'latest'],
    ['a prerelease', '0.8.0-rc.1', PENDING, RC, 'next'],
  ])(
    'refuses %s whose changelog has a second [Unreleased] with notes',
    (_, version, text, ref, tag) => {
      const changelog = text.replace(
        '## [0.7.0]',
        '## [Unreleased]\n\n### Fixed\n- Hidden.\n\n## [0.7.0]',
      );
      const { ok, out } = check(pkg(version, changelog), ref, tag);
      expect(ok).toBe(false);
      expect(out).toContain('"## [Unreleased]" must be the first section');
    },
  );

  it('refuses a changelog that fails the format lint', () => {
    const changelog = PROMOTED.replace('### Added', '### Improved');
    const { ok, out } = check(pkg('0.8.0', changelog), RELEASE, 'latest');
    expect(ok).toBe(false);
    expect(out).toContain('Improved');
  });

  it.each([
    ['0.8.0-rc.lock', 'sdk', 'tag "sdk-v0.8.0-rc.lock", which git refuses as a ref name'],
    ['0.8.0-rc.1+b.lock', 'sdk', 'tag "sdk-v0.8.0-rc.1+b.lock", which git refuses as a ref name'],
    ['0.8.0-rc.1', 'a..b', 'tag "a..b-v0.8.0-rc.1", which git refuses as a ref name'],
    ['0.8.0-rc.1', 'Bad Name', 'package name "Bad Name"'],
    ['0.8.0-rc.1', '', 'package name ""'],
  ])('refuses %s as package %s, whose release tag git cannot create', (version, name, message) => {
    const { ok, out } = check(pkg(version, PENDING), RC, 'next', name);
    expect(ok).toBe(false);
    expect(out).toContain(`after the publish: invalid ${message}`);
  });

  it('fails when the changelog is missing', () => {
    const { ok, out } = check(pkg('0.8.0'), RELEASE, 'latest');
    expect(ok).toBe(false);
    expect(out).toContain('CHANGELOG.md: not found');
  });

  it('fails a package without a version', () => {
    const root = tempDir();
    writeFile(root, 'package.json', JSON.stringify({ name: '@scope/sdk' }));
    writeFile(root, 'CHANGELOG.md', PROMOTED);
    expect(check(root, RELEASE, 'latest').out).toContain('version "" is not SemVer');
  });
});

describe('changelog release-check CLI', () => {
  const run = (args) => {
    try {
      return {
        code: 0,
        out: execFileSync('node', [bin, 'changelog', 'release-check', ...args], {
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };

  it('exits 0 for a final version from a release branch', () => {
    const root = pkg('0.8.0', PROMOTED);
    expect(
      run(['--ref', RELEASE, '--dist-tag', 'latest', '--package-name', 'sdk', '--cwd', root]).code,
    ).toBe(0);
  });

  it('exits 1 for a final version from main', () => {
    const root = pkg('0.8.0', PROMOTED);
    const { code, out } = run([
      '--ref',
      'refs/heads/main',
      '--dist-tag',
      'latest',
      '--package-name',
      'sdk',
      '--cwd',
      root,
    ]);
    expect(code).toBe(1);
    expect(out).toContain('publish it from a branch named release/*');
  });

  it('exits 2 without --ref, --dist-tag or --package-name', () => {
    const root = pkg('0.8.0', PROMOTED);
    const name = ['--package-name', 'sdk'];
    expect(run(['--dist-tag', 'latest', ...name, '--cwd', root]).code).toBe(2);
    expect(run(['--ref', RELEASE, ...name, '--cwd', root]).code).toBe(2);
    expect(run(['--ref', '', '--dist-tag', 'latest', ...name, '--cwd', root]).code).toBe(2);
    expect(run(['--ref', RELEASE, '--dist-tag', 'latest', '--cwd', root]).code).toBe(2);
  });
});
