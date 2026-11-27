// Parser and format lint for the publishable packages' Keep a Changelog files.
//
// The changelog is what a release reads to decide which packages ship and what
// their notes say, so its structure is checked, not just its presence.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CHANGELOG_FILENAME = 'CHANGELOG.md';

// Keep a Changelog's six types, plus Breaking and Migration: both carry release
// information (a major bump, upgrade steps) the six cannot express.
export const ALLOWED_SUBSECTIONS = Object.freeze([
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
  'Breaking',
  'Migration',
]);

export const UNRELEASED = 'Unreleased';

// semver.org's reference pattern for a full version (core, prerelease, build).
const SEMVER =
  '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)' +
  '(?:-(?:(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?' +
  '(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?';
const VERSION = new RegExp(`^${SEMVER}$`);
const VERSION_HEADING = new RegExp(`^\\[(${SEMVER})\\] - (\\d{4}-\\d{2}-\\d{2})$`);
const FENCE = /^\s*(`{3,}|~{3,})/;
const KEEP_A_CHANGELOG_LINK = /\]\(https:\/\/keepachangelog\.com\//;
const SEMVER_LINK = /\]\(https:\/\/semver\.org\//;

/**
 * An ATX heading as `{ level, title }`, or null. Parsed by hand because the
 * equivalent regex backtracks polynomially on long lines of spaces.
 */
function parseHeading(raw) {
  let level = 0;
  while (raw[level] === '#') level++;
  if (level === 0 || level > 6 || !/\s/.test(raw[level] ?? '')) return null;
  let title = raw.slice(level).trim();
  let end = title.length;
  while (end > 0 && title[end - 1] === '#') end--;
  title = title.slice(0, end).trimEnd();
  if (/[\r\u2028\u2029]/.test(title)) return null;
  return { level, title };
}

/**
 * The fence state after `raw`: a line opens a block, or closes the open one only
 * when it uses the same character, is at least as long and has nothing after it.
 */
function nextFence(raw, open) {
  const m = FENCE.exec(raw);
  if (!m) return open;
  const marks = m[1];
  const rest = raw.slice(m[0].length);
  if (!open) {
    return marks[0] === '`' && rest.includes('`') ? null : { char: marks[0], length: marks.length };
  }
  const closes = marks[0] === open.char && marks.length >= open.length && rest.trim() === '';
  return closes ? null : open;
}

function isRealDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Splits text into lines, dropping a BOM and CRLF endings. */
function toLines(text) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/);
}

/**
 * @typedef {{ line: number, message: string }} Problem
 * @typedef {{ name: string, line: number, entries: string[] }} Subsection
 * @typedef {{
 *   title: string,            // 'Unreleased', a version, or the raw heading text when malformed
 *   unreleased: boolean,      // heading is exactly `## [Unreleased]`
 *   date: string | null,
 *   line: number,
 *   valid: boolean,           // heading is `[Unreleased]` or `[X.Y.Z] - YYYY-MM-DD` with a real date
 *   entries: string[],        // every non-blank content line in the section, subsections included
 *   subsections: Subsection[],
 * }} Section
 */

/**
 * Parses a changelog into its header problems and `##` sections. Line numbers are
 * 1-based. Lines inside fenced code blocks are content, never headings.
 *
 * @param {string} text
 * @returns {{ headerProblems: Problem[], sections: Section[], strayHeadings: Problem[] }}
 */
export function parseChangelog(text) {
  const lines = toLines(text);
  const headerProblems = [];
  const sections = [];
  // `###` headings before the first `##`: their entries belong to no release.
  const strayHeadings = [];
  let section = null;
  let subsection = null;
  let fence = null;
  let sawKeepAChangelog = false;
  let sawSemver = false;

  lines.forEach((raw, i) => {
    const line = i + 1;
    const next = nextFence(raw, fence);
    const heading = !fence && !next ? parseHeading(raw) : null;
    fence = next;

    if (heading && heading.level <= 3) {
      const { level, title } = heading;
      if (level === 1) {
        if (line !== 1) {
          headerProblems.push({
            line,
            message: `unexpected top-level heading "# ${title}"; only line 1 may be "# Changelog"`,
          });
        }
        return;
      }
      if (level === 2) {
        const m = VERSION_HEADING.exec(title);
        const isUnreleased = title === `[${UNRELEASED}]`;
        section = {
          title: isUnreleased ? UNRELEASED : m ? m[1] : title,
          unreleased: isUnreleased,
          date: m ? m[2] : null,
          line,
          valid: isUnreleased || (m !== null && isRealDate(m[2])),
          entries: [],
          subsections: [],
        };
        sections.push(section);
        subsection = null;
        return;
      }
      // level 3
      if (!section) {
        strayHeadings.push({ line, message: `heading "${raw.trim()}" before "## [Unreleased]"` });
        return;
      }
      subsection = { name: title, line, entries: [] };
      section.subsections.push(subsection);
      return;
    }

    if (raw.trim() === '') return;
    if (!section) {
      if (line === 1) return;
      if (KEEP_A_CHANGELOG_LINK.test(raw)) sawKeepAChangelog = true;
      if (SEMVER_LINK.test(raw)) sawSemver = true;
      return;
    }
    section.entries.push(raw.trimEnd());
    if (subsection) subsection.entries.push(raw.trimEnd());
  });

  if (lines[0] !== '# Changelog') {
    headerProblems.unshift({ line: 1, message: 'first line must be "# Changelog"' });
  }
  const headerEnd = sections[0]?.line ?? lines.length;
  if (!sawKeepAChangelog) {
    headerProblems.push({
      line: headerEnd,
      message: 'header must link Keep a Changelog (keepachangelog.com) before the first "##"',
    });
  }
  if (!sawSemver) {
    headerProblems.push({
      line: headerEnd,
      message: 'header must link Semantic Versioning (semver.org) before the first "##"',
    });
  }
  return { headerProblems, sections, strayHeadings };
}

/**
 * Format lint. Returns every problem found, sorted by line; an empty array means
 * the changelog is well formed. An empty `[Unreleased]` is valid (it is empty right
 * after each release); release dates are not checked for order.
 *
 * @param {string} text
 * @returns {Problem[]}
 */
export function lintChangelog(text) {
  const { headerProblems, sections, strayHeadings } = parseChangelog(text);
  const problems = [...headerProblems, ...strayHeadings];

  if (sections.length === 0 || !sections[0].unreleased) {
    problems.push({
      line: sections[0]?.line ?? 1,
      message: 'the first "##" section must be "## [Unreleased]"',
    });
  }

  const seen = new Map();
  sections.forEach((s, idx) => {
    if (s.unreleased && idx !== 0) {
      problems.push({ line: s.line, message: '"## [Unreleased]" must be the first section' });
    } else if (!s.valid) {
      problems.push({
        line: s.line,
        message: `version heading must read "## [X.Y.Z] - YYYY-MM-DD" with a SemVer version and a real date, got "## ${s.date ? `[${s.title}] - ${s.date}` : s.title}"`,
      });
    }
    const key = s.unreleased ? `[${UNRELEASED}]` : s.title;
    if (seen.has(key)) {
      problems.push({
        line: s.line,
        message: `duplicate section "${key}" (first at line ${seen.get(key)})`,
      });
    } else {
      seen.set(key, s.line);
    }
    if (!s.unreleased && s.entries.length === 0) {
      problems.push({ line: s.line, message: `section "${s.title}" has no content` });
    }
    for (const sub of s.subsections) {
      if (!ALLOWED_SUBSECTIONS.includes(sub.name)) {
        problems.push({
          line: sub.line,
          message: `unknown heading "### ${sub.name}"; allowed: ${ALLOWED_SUBSECTIONS.join(', ')}`,
        });
      }
      if (sub.entries.length === 0) {
        problems.push({ line: sub.line, message: `"### ${sub.name}" has no content` });
      }
    }
  });

  return problems.sort((a, b) => a.line - b.line);
}

/**
 * Splits a SemVer version into its `X.Y.Z` core and whether it is a prerelease
 * (`X.Y.Z-rc.1`). Build metadata alone (`X.Y.Z+build`) is not a prerelease.
 * Returns null when `version` is not SemVer.
 *
 * @param {string} version
 * @returns {{ core: string, prerelease: boolean } | null}
 */
export function parseVersion(version) {
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  const core = /^\d+\.\d+\.\d+/.exec(version)[0];
  return { core, prerelease: version[core.length] === '-' };
}

/**
 * Checks that the changelog carries the release notes for `version`:
 *
 * - a prerelease `X.Y.Z-rc.N` ships the notes under `## [Unreleased]`, so that
 *   section must have content and `## [X.Y.Z]` must not exist yet;
 * - a final `X.Y.Z` must have its own `## [X.Y.Z] - YYYY-MM-DD` section with content,
 *   and an empty `## [Unreleased]` unless `allowPending` is set.
 *
 * @param {string} text
 * @param {string} version
 * @param {{ allowPending?: boolean }} [options] allowPending accepts entries under
 *   `## [Unreleased]` next to a final version: changes that belong to the next release.
 * @returns {Problem[]}
 */
export function checkReleaseNotes(text, version, { allowPending = false } = {}) {
  const v = parseVersion(version);
  if (!v) {
    return [
      {
        line: 1,
        message: `version ${JSON.stringify(version)} is not SemVer (X.Y.Z or X.Y.Z-rc.N)`,
      },
    ];
  }
  const { sections } = parseChangelog(text);
  const unreleased = sections.find((s) => s.unreleased);
  const sectionFor = (title) => sections.find((s) => !s.unreleased && s.title === title);

  if (v.prerelease) {
    const problems = [];
    const released = sectionFor(v.core);
    if (released) {
      problems.push({
        line: released.line,
        message: `"## [${v.core}]" already exists, so ${version} would follow its own release; use a prerelease of a newer version`,
      });
    }
    if (!unreleased || unreleased.entries.length === 0) {
      problems.push({
        line: unreleased?.line ?? 1,
        message: `"## [${UNRELEASED}]" has no notes; a prerelease ships the notes under it`,
      });
    }
    return problems;
  }

  const section = sectionFor(version);
  if (!section) {
    return [
      {
        line: unreleased?.line ?? 1,
        message: `no "## [${version}] - YYYY-MM-DD" section; move the "## [${UNRELEASED}]" notes under it`,
      },
    ];
  }
  if (!section.valid) {
    return [{ line: section.line, message: `"## [${version}]" needs a real date (YYYY-MM-DD)` }];
  }
  const problems = [];
  if (section.entries.length === 0) {
    problems.push({ line: section.line, message: `"## [${version}]" has no notes` });
  }
  // Each entry stands for a change in the build that these notes do not describe.
  if (!allowPending && unreleased && unreleased.entries.length > 0) {
    problems.push({
      line: unreleased.line,
      message: `"## [${UNRELEASED}]" still has notes; a release ships only what "## [${version}]" lists, so move them under it or release from a commit before those changes`,
    });
  }
  return problems.sort((a, b) => a.line - b.line);
}

/**
 * Lints `<pkgRoot>/CHANGELOG.md` and prints each problem as `path:line: message`.
 * Returns true when the file is well formed.
 */
export function lintChangelogFile(pkgRoot, { log = console.log, error = console.error } = {}) {
  const path = join(pkgRoot, CHANGELOG_FILENAME);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    error(`✗ ${path}: not found`);
    return false;
  }
  const problems = lintChangelog(text);
  for (const p of problems) error(`✗ ${path}:${p.line}: ${p.message}`);
  if (problems.length === 0) log(`✓ ${path}: changelog format ok`);
  return problems.length === 0;
}
