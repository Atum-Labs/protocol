import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lintChangelog,
  parseChangelog,
  lintChangelogFile,
  parseVersion,
  checkReleaseNotes,
} from '../src/changelog.mjs';
import { tempDir, writeFile, cleanupAll } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');
const bin = join(here, '../bin/publish-guard.mjs');

afterAll(cleanupAll);

const HEADER = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`;

/** Prepends the standard header to `body`. */
function changelog(body) {
  return `${HEADER}\n${body}`;
}
function lineOf(text, marker) {
  return text.split('\n').findIndex((l) => l === marker) + 1;
}

const VALID = changelog(`## [Unreleased]

### Added
- A new thing.

## [1.0.0] - 2026-07-21

### Fixed
- A fix.
`);

describe('lintChangelog', () => {
  it.each([
    'schemas/apis/payment-gateway/v1/bindings/typescript/client/CHANGELOG.md',
    'schemas/apis/payment-gateway/v1/bindings/typescript/mppx-atum-escrow/CHANGELOG.md',
    'schemas/apis/x402/v1/bindings/x402-atum-escrow/CHANGELOG.md',
  ])('accepts the repo changelog %s unmodified', (rel) => {
    expect(lintChangelog(readFileSync(join(repoRoot, rel), 'utf8'))).toEqual([]);
  });

  it('accepts a well-formed changelog', () => {
    expect(lintChangelog(VALID)).toEqual([]);
  });

  it('accepts an empty [Unreleased]', () => {
    expect(
      lintChangelog(changelog('## [Unreleased]\n\n## [1.0.0] - 2026-07-21\n\n### Added\n- x\n')),
    ).toEqual([]);
  });

  it('accepts Breaking and Migration headings and a prerelease version', () => {
    const text = changelog(
      '## [Unreleased]\n\n## [2.0.0-rc.1] - 2026-07-21\n\n### Breaking\n- x\n\n### Migration\n- y\n',
    );
    expect(lintChangelog(text)).toEqual([]);
  });

  it('rejects ### Notes, naming its line', () => {
    const text = changelog('## [Unreleased]\n\n### Notes\n- x\n');
    expect(lintChangelog(text)).toEqual([
      {
        line: lineOf(text, '### Notes'),
        message: expect.stringContaining('unknown heading "### Notes"'),
      },
    ]);
  });

  it('rejects ## [1.2] - 2026-1-5, naming its line', () => {
    const text = changelog('## [Unreleased]\n\n## [1.2] - 2026-1-5\n\n### Added\n- x\n');
    expect(lintChangelog(text)).toEqual([
      {
        line: lineOf(text, '## [1.2] - 2026-1-5'),
        message: expect.stringContaining('## [X.Y.Z] - YYYY-MM-DD'),
      },
    ]);
  });

  it.each([
    '## [1.0.0] - 2026-02-30',
    '## [01.0.0] - 2026-02-01',
    '## [1.0.0]',
    '## 1.0.0 - 2026-02-01',
  ])('rejects the malformed version heading %s', (heading) => {
    const text = changelog(`## [Unreleased]\n\n${heading}\n\n### Added\n- x\n`);
    expect(lintChangelog(text)).toEqual([
      { line: lineOf(text, heading), message: expect.stringContaining('## [X.Y.Z] - YYYY-MM-DD') },
    ]);
  });

  it('rejects an empty ### Fixed, naming its line', () => {
    const text = changelog('## [Unreleased]\n\n### Fixed\n\n### Added\n- x\n');
    expect(lintChangelog(text)).toEqual([
      { line: lineOf(text, '### Fixed'), message: '"### Fixed" has no content' },
    ]);
  });

  it('rejects an empty version section', () => {
    const text = changelog('## [Unreleased]\n\n## [1.0.0] - 2026-07-21\n');
    expect(lintChangelog(text)).toEqual([
      { line: lineOf(text, '## [1.0.0] - 2026-07-21'), message: 'section "1.0.0" has no content' },
    ]);
  });

  it('rejects a duplicate version', () => {
    const text = changelog(
      '## [Unreleased]\n\n## [1.0.0] - 2026-07-21\n\n### Added\n- x\n\n## [1.0.0] - 2026-07-20\n\n### Added\n- y\n',
    );
    expect(lintChangelog(text)).toEqual([
      {
        line: lineOf(text, '## [1.0.0] - 2026-07-20'),
        message: expect.stringContaining('duplicate section "1.0.0"'),
      },
    ]);
  });

  it('rejects a missing header block', () => {
    const problems = lintChangelog('## [Unreleased]\n\n### Added\n- x\n');
    expect(problems.map((p) => p.message)).toEqual([
      'first line must be "# Changelog"',
      expect.stringContaining('keepachangelog.com'),
      expect.stringContaining('semver.org'),
    ]);
  });

  it('rejects a version section before [Unreleased]', () => {
    const text = changelog('## [1.0.0] - 2026-07-21\n\n### Added\n- x\n\n## [Unreleased]\n');
    expect(lintChangelog(text).map((p) => p.line)).toEqual([
      lineOf(text, '## [1.0.0] - 2026-07-21'),
      lineOf(text, '## [Unreleased]'),
    ]);
  });

  it('rejects a changelog with no [Unreleased]', () => {
    const text = changelog('## [1.0.0] - 2026-07-21\n\n### Added\n- x\n');
    expect(lintChangelog(text)).toEqual([
      {
        line: lineOf(text, '## [1.0.0] - 2026-07-21'),
        message: expect.stringContaining('"## [Unreleased]"'),
      },
    ]);
  });

  it('rejects ## Unreleased without brackets', () => {
    const text = changelog('## Unreleased\n\n### Added\n- x\n');
    expect(lintChangelog(text).map((p) => p.line)).toEqual([
      lineOf(text, '## Unreleased'),
      lineOf(text, '## Unreleased'),
    ]);
  });

  it('reports a wrong first line once', () => {
    const text = VALID.replace('# Changelog', '# Change log');
    expect(lintChangelog(text)).toEqual([{ line: 1, message: 'first line must be "# Changelog"' }]);
  });

  it('rejects a ### heading before the first ## section', () => {
    const text = changelog('### Added\n- x\n\n## [Unreleased]\n');
    expect(lintChangelog(text)).toEqual([
      {
        line: lineOf(text, '### Added'),
        message: expect.stringContaining('before "## [Unreleased]"'),
      },
    ]);
  });

  it('rejects a second top-level heading', () => {
    const text = changelog('## [Unreleased]\n\n# Other\n');
    expect(lintChangelog(text)).toEqual([
      {
        line: lineOf(text, '# Other'),
        message: expect.stringContaining('unexpected top-level heading'),
      },
    ]);
  });

  it('handles CRLF line endings and a BOM', () => {
    expect(lintChangelog('﻿' + VALID.replace(/\n/g, '\r\n'))).toEqual([]);
  });

  it('rejects a header that names the links without linking them', () => {
    const text = VALID.replace(
      '[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)',
      'keepachangelog.com',
    ).replace('[Semantic Versioning](https://semver.org/spec/v2.0.0.html)', 'semver.org');
    expect(lintChangelog(text).map((p) => p.message)).toEqual([
      expect.stringContaining('keepachangelog.com'),
      expect.stringContaining('semver.org'),
    ]);
  });

  it('keeps a heading-like line with a lone carriage return as content', () => {
    const text = changelog('## [Unreleased]\n\n### Added\n- x\n### Notes\rmore\n');
    expect(lintChangelog(text)).toEqual([]);
  });

  it('accepts a heading with a closing sequence of #', () => {
    expect(lintChangelog(VALID.replace('### Added', '### Added ##'))).toEqual([]);
  });

  it('lints a heading line of 4,000 spaces quickly', () => {
    const text = changelog(`## [Unreleased]\n\n### Added\n- x\n# a${' '.repeat(4000)}\u2028x\n`);
    const start = performance.now();
    lintChangelog(text);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('treats headings inside fenced code blocks as content', () => {
    const text = changelog(
      '## [Unreleased]\n\n### Changed\n- x\n```ts\n## not a heading\n### Nor this\n```\n',
    );
    expect(lintChangelog(text)).toEqual([]);
  });

  it.each([
    ['a ~~~ line inside a ```` block', '````md\n~~~\n## not a heading\n````'],
    ['a shorter fence inside a ```` block', '````md\n```\n## not a heading\n````'],
    ['a ``` line with text after it', '```md\n```ts\n## not a heading\n```'],
    ['an unclosed block', '~~~\n## not a heading'],
  ])('keeps headings as content after %s', (_, block) => {
    const text = changelog(`## [Unreleased]\n\n### Changed\n- x\n${block}\n`);
    expect(lintChangelog(text)).toEqual([]);
  });

  it('reads headings again after a longer closing fence', () => {
    const text = changelog(
      '## [Unreleased]\n\n### Changed\n- x\n~~~\n- y\n~~~~~\n### Notes\n- z\n',
    );
    expect(lintChangelog(text)).toEqual([
      { line: lineOf(text, '### Notes'), message: expect.stringContaining('unknown heading') },
    ]);
  });

  it('does not open a fence on a backtick line whose info string has a backtick', () => {
    const text = changelog('## [Unreleased]\n\n### Changed\n- x\n``` a`b\n### Notes\n- z\n');
    expect(lintChangelog(text)).toEqual([
      { line: lineOf(text, '### Notes'), message: expect.stringContaining('unknown heading') },
    ]);
  });
});

describe('parseChangelog', () => {
  it('collects entries per section and subsection', () => {
    const { sections } = parseChangelog(VALID);
    expect(sections.map((s) => [s.title, s.date, s.entries])).toEqual([
      ['Unreleased', null, ['- A new thing.']],
      ['1.0.0', '2026-07-21', ['- A fix.']],
    ]);
    expect(sections.map((s) => s.unreleased)).toEqual([true, false]);
    expect(sections[0].subsections).toEqual([
      { name: 'Added', line: lineOf(VALID, '### Added'), entries: ['- A new thing.'] },
    ]);
  });
});

describe('changelog lint CLI', () => {
  const run = (args) => {
    try {
      return {
        code: 0,
        out: execFileSync('node', [bin, ...args], { encoding: 'utf8', stdio: 'pipe' }),
      };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };

  it('exits 0 for a valid changelog', () => {
    const root = tempDir();
    writeFile(root, 'CHANGELOG.md', VALID);
    expect(run(['changelog', 'lint', '--cwd', root]).code).toBe(0);
  });

  it('exits 1 and prints path:line for an invalid changelog', () => {
    const root = tempDir();
    const text = changelog('## [Unreleased]\n\n### Notes\n- x\n');
    writeFile(root, 'CHANGELOG.md', text);
    const { code, out } = run(['--cwd', root, 'changelog', 'lint']);
    expect(code).toBe(1);
    expect(out).toContain(`CHANGELOG.md:${lineOf(text, '### Notes')}: unknown heading`);
  });

  it('exits 1 when the changelog is missing', () => {
    expect(run(['changelog', 'lint', '--cwd', tempDir()]).code).toBe(1);
  });

  it('exits 2 for an unknown changelog subcommand', () => {
    expect(run(['changelog', 'nope', '--cwd', tempDir()]).code).toBe(2);
  });

  it('accepts the command without --cwd', () => {
    const root = tempDir();
    writeFile(root, 'CHANGELOG.md', VALID);
    const out = execFileSync('node', [bin, 'changelog', 'lint'], { cwd: root, encoding: 'utf8' });
    expect(out).toContain('changelog format ok');
  });
});

describe('lintChangelogFile', () => {
  it('returns false and reports each problem', () => {
    const root = tempDir();
    writeFile(root, 'CHANGELOG.md', changelog('## [Unreleased]\n\n### Fixed\n'));
    const errors = [];
    expect(lintChangelogFile(root, { log: () => {}, error: (m) => errors.push(m) })).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe('parseVersion', () => {
  it.each([
    ['0.8.0', { core: '0.8.0', prerelease: false }],
    ['0.8.0-rc.1', { core: '0.8.0', prerelease: true }],
    ['1.0.0-0', { core: '1.0.0', prerelease: true }],
    ['1.0.0-rc.1+build.5', { core: '1.0.0', prerelease: true }],
    ['1.0.0+build-5', { core: '1.0.0', prerelease: false }],
  ])('parses %s', (version, expected) => {
    expect(parseVersion(version)).toEqual(expected);
  });

  it.each(['v1.0.0', '1.0', '', '01.0.0', '1.0.0-', undefined])('rejects %s', (version) => {
    expect(parseVersion(version)).toBeNull();
  });
});

describe('checkReleaseNotes', () => {
  const PENDING = changelog(
    '## [Unreleased]\n\n### Added\n- New thing.\n\n## [0.7.0] - 2026-10-30\n\n### Fixed\n- Old fix.\n',
  );
  const PROMOTED = changelog(
    '## [Unreleased]\n\n## [0.8.0] - 2026-11-12\n\n### Added\n- New thing.\n\n## [0.7.0] - 2026-10-30\n\n### Fixed\n- Old fix.\n',
  );

  it('passes a prerelease with notes under [Unreleased]', () => {
    expect(checkReleaseNotes(PENDING, '0.8.0-rc.1')).toEqual([]);
  });

  it('fails a prerelease when [Unreleased] is empty', () => {
    const text = changelog('## [Unreleased]\n\n### Added\n\n## [0.7.0] - 2026-10-30\n\n- x\n');
    expect(checkReleaseNotes(text, '0.8.0-rc.1')).toEqual([
      { line: lineOf(text, '## [Unreleased]'), message: expect.stringContaining('has no notes') },
    ]);
  });

  it('fails a prerelease of a version that already has its section', () => {
    expect(checkReleaseNotes(PROMOTED, '0.8.0-rc.1')).toEqual([
      {
        line: lineOf(PROMOTED, '## [0.8.0] - 2026-11-12'),
        message: expect.stringContaining('already exists'),
      },
      {
        line: lineOf(PROMOTED, '## [Unreleased]'),
        message: expect.stringContaining('has no notes'),
      },
    ]);
  });

  it('passes a final version with its dated section', () => {
    expect(checkReleaseNotes(PROMOTED, '0.8.0')).toEqual([]);
  });

  it('fails a final version while notes are still under [Unreleased]', () => {
    const text = PROMOTED.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n- Later.\n');
    expect(checkReleaseNotes(text, '0.8.0')).toEqual([
      {
        line: lineOf(text, '## [Unreleased]'),
        message: expect.stringContaining('"## [Unreleased]" still has notes'),
      },
    ]);
  });

  it('accepts [Unreleased] notes next to a final version with allowPending', () => {
    const text = PROMOTED.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n- Later.\n');
    expect(checkReleaseNotes(text, '0.8.0', { allowPending: true })).toEqual([]);
    expect(checkReleaseNotes(PENDING, '0.8.0', { allowPending: true })).toEqual([
      expect.objectContaining({ message: expect.stringContaining('no "## [0.8.0]') }),
    ]);
  });

  it('fails a final version whose notes are still under [Unreleased]', () => {
    expect(checkReleaseNotes(PENDING, '0.8.0')).toEqual([
      {
        line: lineOf(PENDING, '## [Unreleased]'),
        message: 'no "## [0.8.0] - YYYY-MM-DD" section; move the "## [Unreleased]" notes under it',
      },
    ]);
  });

  it('fails a final version when only another version has a section', () => {
    expect(checkReleaseNotes(PROMOTED, '0.9.0')).toEqual([
      { line: lineOf(PROMOTED, '## [Unreleased]'), message: expect.stringContaining('[0.9.0]') },
    ]);
  });

  it('fails a final version whose section is empty or has an impossible date', () => {
    const empty = changelog('## [Unreleased]\n\n## [0.8.0] - 2026-11-12\n');
    expect(checkReleaseNotes(empty, '0.8.0')).toEqual([
      { line: lineOf(empty, '## [0.8.0] - 2026-11-12'), message: '"## [0.8.0]" has no notes' },
    ]);
    const badDate = changelog('## [Unreleased]\n\n## [0.8.0] - 2026-02-30\n\n- x\n');
    expect(checkReleaseNotes(badDate, '0.8.0')[0].message).toContain('real date');
  });

  it('fails a version that is not SemVer, escaping it', () => {
    expect(checkReleaseNotes(PROMOTED, '0.8\n✓ ok')).toEqual([
      { line: 1, message: 'version "0.8\\n✓ ok" is not SemVer (X.Y.Z or X.Y.Z-rc.N)' },
    ]);
  });
});
