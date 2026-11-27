import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseTag, tagRelease } from '../src/tag.mjs';
import { tempDir, writeFile, cleanupAll } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '../bin/publish-guard.mjs');

afterAll(cleanupAll);

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const TAG = 'sdk-v0.8.0-rc.1';

/** A clone whose origin is a bare repo, with two commits: `published` and `other`. */
function repo(version = '0.8.0-rc.1') {
  const root = tempDir();
  const remote = join(root, 'remote.git');
  const clone = join(root, 'clone');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  git(root, 'init', '-q', '--bare', remote);
  git(root, 'init', '-q', '-b', 'main', clone);
  writeFile(clone, 'pkg/package.json', JSON.stringify({ name: '@scope/sdk', version }));
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'published');
  const published = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'other');
  const other = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'remote', 'add', 'origin', remote);
  git(clone, 'push', '-q', 'origin', 'main');
  const remoteRefs = () => git(clone, 'ls-remote', 'origin');
  return { clone, remote, published, other, git: (...a) => git(clone, ...a), remoteRefs };
}

function run(r, overrides = {}) {
  const out = [];
  const ok = tagRelease({
    pkgRoot: join(r.clone, 'pkg'),
    packageName: 'sdk',
    sha: r.published,
    cwd: r.clone,
    log: (m) => out.push(m),
    error: (m) => out.push(m),
    ...overrides,
  });
  return { ok, out: out.join('\n') };
}

describe('tagRelease', () => {
  it('pushes <name>-v<version> at the published commit', () => {
    const r = repo();
    const { ok, out } = run(r);
    expect(ok).toBe(true);
    expect(out).toContain(`✓ pushed tag ${TAG} at ${r.published}`);
    expect(r.remoteRefs()).toContain(`${r.published}\trefs/tags/${TAG}`);
  });

  it('passes without pushing when the tag is already on the published commit', () => {
    const r = repo();
    r.git('push', '-q', 'origin', `${r.published}:refs/tags/${TAG}`);
    const before = r.remoteRefs();
    const { ok, out } = run(r);
    expect(ok).toBe(true);
    expect(out).toBe(`✓ tag ${TAG} is already on ${r.published}`);
    expect(r.remoteRefs()).toBe(before);
  });

  it('reads the commit of an annotated tag', () => {
    const r = repo();
    r.git('tag', '-a', TAG, '-m', 'release', r.published);
    r.git('push', '-q', 'origin', TAG);
    expect(run(r).ok).toBe(true);
    expect(run(r, { sha: r.other }).ok).toBe(false);
  });

  it('fails when the tag points at another commit, and leaves it there', () => {
    const r = repo();
    r.git('push', '-q', 'origin', `${r.other}:refs/tags/${TAG}`);
    const { ok, out } = run(r);
    expect(ok).toBe(false);
    expect(out).toContain(`✗ tag ${TAG} points at ${r.other}, not at ${r.published}`);
    expect(r.remoteRefs()).toContain(`${r.other}\trefs/tags/${TAG}`);
  });

  it('refuses when a branch name ends with the tag ref, since the push would update it', () => {
    const r = repo();
    r.git('push', '-q', 'origin', `${r.published}:refs/heads/refs/tags/${TAG}`);
    const before = r.remoteRefs();
    const { ok, out } = run(r);
    expect(ok).toBe(false);
    expect(out).toContain(`✗ cannot tag: origin has refs/heads/refs/tags/${TAG}`);
    expect(r.remoteRefs()).toBe(before);
  });

  it('fails with the command to tag by hand when origin is unreachable', () => {
    const r = repo();
    r.git('remote', 'set-url', 'origin', join(r.remote, 'missing'));
    const { ok, out } = run(r);
    expect(ok).toBe(false);
    expect(out).toContain('did not tag it. Re-run the failed jobs');
    expect(out).toContain(`git push origin ${r.published}:refs/tags/${TAG}`);
  });

  it.each([
    ['package name', { packageName: 'Bad Name' }],
    ['package name', { packageName: undefined }],
    ['commit', { sha: 'main' }],
    ['commit', { sha: undefined }],
  ])('refuses an invalid %s without touching git', (what, overrides) => {
    const r = repo();
    const before = r.remoteRefs();
    const { ok, out } = run(r, overrides);
    expect(ok).toBe(false);
    expect(out).toContain(`✗ cannot tag: invalid ${what}`);
    expect(r.remoteRefs()).toBe(before);
  });

  it('refuses a version that is not SemVer', () => {
    const r = repo('latest');
    const { ok, out } = run(r);
    expect(ok).toBe(false);
    expect(out).toContain('✗ cannot tag: invalid version "latest"');
  });

  it('refuses a SemVer version that git refuses as a tag, without touching git', () => {
    const r = repo('0.8.0-rc.lock');
    const before = r.remoteRefs();
    const { ok, out } = run(r);
    expect(ok).toBe(false);
    expect(out).toContain(
      '✗ cannot tag: invalid tag "sdk-v0.8.0-rc.lock", which git refuses as a ref name',
    );
    expect(r.remoteRefs()).toBe(before);
  });
});

describe('releaseTag', () => {
  it.each([
    ['sdk', '0.8.0'],
    ['sdk', '0.8.0-rc.1'],
    ['mppx-atum-escrow', '1.0.0-0'],
    ['sdk', '0.8.0-rc.1+build.5'],
  ])('accepts %s at %s', (name, version) => {
    expect(releaseTag(name, version)).toEqual({
      tag: `${name}-v${version}`,
      ref: `refs/tags/${name}-v${version}`,
      invalid: [],
    });
  });

  it.each([
    ['sdk', '0.8.0-rc.lock', 'tag "sdk-v0.8.0-rc.lock", which git refuses as a ref name'],
    ['sdk', '0.8.0+lock.lock', 'tag "sdk-v0.8.0+lock.lock", which git refuses as a ref name'],
    ['a..b', '0.8.0', 'tag "a..b-v0.8.0", which git refuses as a ref name'],
    ['Bad', '0.8.0', 'package name "Bad"'],
    ['sdk', 'v0.8.0', 'version "v0.8.0"'],
  ])('refuses %s at %s', (name, version, message) => {
    expect(releaseTag(name, version).invalid).toEqual([message]);
  });
});

describe('publish-guard tag-release CLI', () => {
  const cli = (r, args) => {
    try {
      execFileSync('node', [bin, 'tag-release', ...args], { cwd: r.clone, env, stdio: 'pipe' });
      return 0;
    } catch (e) {
      return e.status;
    }
  };

  it('exits 0 after tagging and 1 for a tag on another commit', () => {
    const r = repo();
    const args = ['--package-name', 'sdk', '--cwd', 'pkg'];
    expect(cli(r, [...args, '--sha', r.published])).toBe(0);
    expect(r.remoteRefs()).toContain(`${r.published}\trefs/tags/${TAG}`);
    expect(cli(r, [...args, '--sha', r.other])).toBe(1);
  });

  it('exits 2 without --package-name or --sha', () => {
    const r = repo();
    expect(cli(r, ['--sha', r.published, '--cwd', 'pkg'])).toBe(2);
    expect(cli(r, ['--package-name', 'sdk', '--cwd', 'pkg'])).toBe(2);
  });
});
