// Pull-request check: which publishable packages does a change reach, and did
// each one's CHANGELOG.md gain an entry?
//
// A package is "publishable" when it carries publish-guard.config.mjs. A change to
// any workspace package also reaches the publishable packages that depend on it,
// because they bundle their workspace dependencies. So does a change to a file
// outside a package that the package's src/ imports by relative path.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import {
  CHANGELOG_FILENAME,
  UNRELEASED,
  checkReleaseNotes,
  lintChangelog,
  parseChangelog,
} from './changelog.mjs';
import { CONFIG_FILENAME } from './config.mjs';
import { walk } from './paths.mjs';

export const ESCAPE_LABEL = 'changelog: none';
const ESCAPE_LINE = /^Changelog:\s*none\s*[—–-]\s*(\S.*)$/i;
const TEST_DIRS = new Set(['test', 'tests', '__tests__']);
const TEST_FILE = /\.(?:test|spec)\.[^/]|^(?:jest|vitest)\.config\.[^/]+$|^tsconfig\.test\.json$/;
// The Go bindings share directories with the TypeScript packages; no npm package ships Go.
const GO_FILE = /\.go$|^go\.(mod|sum)$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
// It decides which package owns which file, so it reaches every publishable package.
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
// Relative specifiers of import/export-from, side-effect imports, import() and require().
const RELATIVE_SPECIFIER = /\b(?:from|import|require)\s*(?:\(\s*)?['"](\.\.?\/[^'"\n]*)['"]/g;
// TypeScript resolves an import of `x.js` to `x.ts`, and likewise for the other module extensions.
const TS_SOURCES = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
};

const inDir = (dir, name) => (dir === '' ? name : `${dir}/${name}`);
// File names come from the PR; a newline in one would start a new log line.
const printable = (s) => JSON.stringify(s).slice(1, -1);

/**
 * @typedef {{ name: string, dir: string, workspaceDeps: string[], inputs?: string[], sdk?: boolean }} Project
 *   `dir` is repo-relative with `/` separators; `''` is the workspace root. `inputs`
 *   are repo-relative files outside `dir` that its src/ imports, as written plus
 *   the TypeScript sources of a `.js` import (an extensionless import matches any
 *   extension).
 * @typedef {{ name: string, dir: string, via: string }} SelectedSdk
 */

/**
 * Drops the changed files that never require a changelog entry: release tooling,
 * tests and test configs, Go sources, the publishable packages' own changelogs,
 * and version-only package.json edits. The last two make up a release PR, which must not select anything.
 *
 * @param {string[]} files repo-relative paths
 * @param {{ sdkDirs: string[], isVersionOnly: (path: string) => boolean }} opts
 * @returns {string[]}
 */
export function filterChangedFiles(files, { sdkDirs, isVersionOnly }) {
  const changelogs = new Set(sdkDirs.map((d) => inDir(d, CHANGELOG_FILENAME)));
  return files.filter((f) => {
    if (f.startsWith('tooling/')) return false;
    const parts = f.split('/');
    const base = parts.pop();
    if (parts.some((p) => TEST_DIRS.has(p)) || TEST_FILE.test(base)) return false;
    if (GO_FILE.test(base)) return false;
    if (changelogs.has(f)) return false;
    if (base === 'package.json' && isVersionOnly(f)) return false;
    return true;
  });
}

/** The deepest project whose directory contains `file`. */
function ownerOf(file, projects) {
  let owner = null;
  for (const p of projects) {
    if (p.dir !== '' && !file.startsWith(`${p.dir}/`)) continue;
    if (!owner || p.dir.length > owner.dir.length) owner = p;
  }
  return owner;
}

const importsFile = (input, file) =>
  file === input || file.startsWith(`${input}.`) || file.startsWith(`${input}/`);

// README and docs ship only in their own package's tarball, never in a dependent's bundle.
function isDocs(file, ownerDir) {
  const rel = ownerDir === '' ? file : file.slice(ownerDir.length + 1);
  return /\.md$/i.test(file) || rel.startsWith('docs/');
}

/**
 * Maps each changed file to the project that owns it and the projects whose src/
 * imports it, then to the publishable packages those reach through `workspace:`
 * dependencies (themselves included).
 *
 * @param {{ files: string[], projects: Project[], sdkNames: string[] }} opts
 * @returns {SelectedSdk[]} sorted by name; `via` is the first file that selected it
 */
export function selectSdks({ files, projects, sdkNames }) {
  const byName = new Map(projects.map((p) => [p.name, p]));
  const dependents = new Map();
  for (const p of projects) {
    for (const dep of p.workspaceDeps) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(p.name);
    }
  }
  const sdks = new Set(sdkNames);
  const selected = new Map();

  for (const file of files) {
    if (file === WORKSPACE_FILE) {
      for (const name of sdks) {
        if (!selected.has(name)) selected.set(name, { name, dir: byName.get(name).dir, via: file });
      }
      continue;
    }
    const owner = ownerOf(file, projects);
    const importers = projects
      .filter((p) => (p.inputs ?? []).some((input) => importsFile(input, file)))
      .map((p) => p.name);
    const queue = [...importers];
    if (owner && !isDocs(file, owner.dir)) queue.push(owner.name);
    const reached = new Set(owner ? [owner.name, ...importers] : importers);
    while (queue.length) {
      for (const d of dependents.get(queue.shift()) ?? []) {
        if (!reached.has(d)) {
          reached.add(d);
          queue.push(d);
        }
      }
    }
    for (const name of reached) {
      if (sdks.has(name) && !selected.has(name)) {
        selected.set(name, { name, dir: byName.get(name).dir, via: file });
      }
    }
  }
  return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * True when the head changelog adds a content line under `[Unreleased]`, or adds a
 * version section with content (a release). Lines are compared trimmed, so a
 * whitespace-only edit, a reworded heading or a deleted entry is not an entry.
 *
 * @param {string | null} baseText null when the base has no changelog
 * @param {string} headText
 */
export function entryAdded(baseText, headText) {
  const base = baseText === null ? [] : parseChangelog(baseText).sections;
  const head = parseChangelog(headText).sections;
  const unreleased = (sections) => sections.find((s) => s.unreleased)?.entries ?? [];

  const remaining = new Map();
  for (const e of unreleased(base)) remaining.set(e.trim(), (remaining.get(e.trim()) ?? 0) + 1);
  for (const e of unreleased(head)) {
    const n = remaining.get(e.trim()) ?? 0;
    if (n === 0) return true;
    remaining.set(e.trim(), n - 1);
  }

  const released = new Set(base.filter((s) => !s.unreleased).map((s) => s.title));
  return head.some(
    (s) => s.valid && !s.unreleased && !released.has(s.title) && s.entries.length > 0,
  );
}

/**
 * The opt-out for a PR with nothing to announce: the `changelog: none` label plus a
 * `Changelog: none — <reason>` line in the PR description. The label alone fails.
 *
 * @param {{ labels: string[], body: string | null }} opts
 * @returns {{ used: boolean, ok: boolean, reason?: string }}
 */
export function escapeHatch({ labels, body }) {
  if (!labels.some((l) => l.toLowerCase() === ESCAPE_LABEL)) return { used: false, ok: true };
  for (const line of (body ?? '').split(/\r?\n/)) {
    const m = ESCAPE_LINE.exec(line.trim());
    if (m) return { used: true, ok: true, reason: m[1].trim() };
  }
  return { used: true, ok: false };
}

/** Repo-relative files outside `dir` that the non-test sources under `dir/src` import. */
function externalInputs(root, dir) {
  const src = join(root, dir, 'src');
  if (dir === '' || !existsSync(src)) return [];
  const inputs = new Set();
  for (const abs of walk(src)) {
    const file = relative(root, abs).split(sep).join('/');
    const parts = file.split('/');
    const base = parts.pop();
    if (!SOURCE_FILE.test(base) || TEST_FILE.test(base) || parts.some((p) => TEST_DIRS.has(p))) {
      continue;
    }
    for (const [, spec] of readFileSync(abs, 'utf8').matchAll(RELATIVE_SPECIFIER)) {
      let target = posix.normalize(posix.join(parts.join('/'), spec));
      if (target.endsWith('/')) target = target.slice(0, -1);
      if (target.startsWith(`${dir}/`)) continue;
      inputs.add(target);
      const ext = posix.extname(target);
      for (const ts of TS_SOURCES[ext] ?? []) inputs.add(target.slice(0, -ext.length) + ts);
    }
  }
  return [...inputs].sort();
}

/** Workspace projects from pnpm, with their `workspace:` edges, external inputs and publishable flag. */
export function listProjects(repoRoot) {
  const root = realpathSync(repoRoot);
  const out = execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out).map(({ name, path }) => {
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    const workspaceDeps = new Set();
    for (const field of DEP_FIELDS) {
      for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
        if (String(spec).startsWith('workspace:')) workspaceDeps.add(dep);
      }
    }
    const dir = relative(root, realpathSync(path)).split(sep).join('/');
    return {
      name,
      dir,
      workspaceDeps: [...workspaceDeps],
      inputs: externalInputs(root, dir),
      sdk: existsSync(join(path, CONFIG_FILENAME)),
    };
  });
}

/** The workspace projects as of commit `sha`, listed from an export of it in a temporary directory. */
function listProjectsAt(git, sha) {
  const tmp = mkdtempSync(join(tmpdir(), 'changelog-pr-'));
  try {
    const tar = join(tmp, 'tree.tar');
    const tree = join(tmp, 'tree');
    mkdirSync(tree);
    git('archive', '--format=tar', '-o', tar, sha);
    execFileSync('tar', ['-xf', tar, '-C', tree], { stdio: ['ignore', 'ignore', 'pipe'] });
    return listProjects(tree);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Runs the whole check on the commits between the merge base of `base` and `head`,
 * and `head`. Everything is read from git, the project graph included, so the
 * result does not depend on the checkout or the working tree. Returns true when it
 * passes.
 *
 * @param {{
 *   cwd?: string, base: string, head?: string, labels?: string[], body?: string | null,
 *   log?: (m: string) => void, error?: (m: string) => void,
 * }} opts
 */
export function runPrCheck({
  cwd = process.cwd(),
  base,
  head = 'HEAD',
  labels = [],
  body = '',
  log = console.log,
  error = console.error,
}) {
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (ref) => {
    try {
      return git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).trim();
    } catch {
      throw new Error(`"${ref}" is not a commit in this checkout; fetch it first`);
    }
  };
  const read = (sha, path) => {
    try {
      return git('cat-file', 'blob', `${sha}:${path}`);
    } catch {
      return null;
    }
  };

  const headSha = commit(head);
  const baseSha = commit(base);
  let mergeBase;
  try {
    mergeBase = git('merge-base', baseSha, headSha).trim();
  } catch {
    throw new Error(
      `no merge base between ${base} and ${head}; the checkout needs the full history (fetch-depth: 0)`,
    );
  }

  // A package that drops its config in this change is still checked.
  const projects = listProjectsAt(git, headSha).map((p) =>
    p.sdk || read(mergeBase, inDir(p.dir, CONFIG_FILENAME)) === null ? p : { ...p, sdk: true },
  );
  const sdkProjects = projects.filter((p) => p.sdk);
  if (sdkProjects.length === 0) {
    throw new Error(`no publishable packages (${CONFIG_FILENAME}) found in the workspace`);
  }

  const isVersionOnly = (path) => {
    const strip = (text) => {
      try {
        const { version: _version, ...rest } = JSON.parse(text);
        return JSON.stringify(rest);
      } catch {
        return null;
      }
    };
    const before = read(mergeBase, path);
    const after = read(headSha, path);
    return (
      before !== null && after !== null && strip(before) !== null && strip(before) === strip(after)
    );
  };

  const changed = git('diff', '--name-only', '--no-renames', '-z', mergeBase, headSha)
    .split('\0')
    .filter(Boolean);
  const files = filterChangedFiles(changed, {
    sdkDirs: sdkProjects.map((p) => p.dir),
    isVersionOnly,
  });
  const selected = selectSdks({ files, projects, sdkNames: sdkProjects.map((p) => p.name) });
  const changelogPath = (dir) => inDir(dir, CHANGELOG_FILENAME);

  let ok = true;

  let lintOk = 0;
  for (const p of sdkProjects) {
    const text = read(headSha, changelogPath(p.dir));
    if (text === null) {
      error(`✗ ${changelogPath(p.dir)}: not found`);
      continue;
    }
    const problems = lintChangelog(text);
    for (const pr of problems) error(`✗ ${changelogPath(p.dir)}:${pr.line}: ${pr.message}`);
    if (problems.length === 0) lintOk++;
  }
  log(`Changelog format: ${lintOk}/${sdkProjects.length} ok`);
  if (lintOk !== sdkProjects.length) ok = false;

  // A version bump must carry its notes; the escape hatch does not cover it. Entries
  // under [Unreleased] are allowed: a release branch that merged main to resolve a
  // changelog conflict carries the next release's notes there. The publish check,
  // which sees the build, still requires that section empty.
  const versionAt = (sha, dir) => {
    try {
      const { version } = JSON.parse(read(sha, inDir(dir, 'package.json')) ?? 'null') ?? {};
      return typeof version === 'string' ? version : null;
    } catch {
      return null;
    }
  };
  for (const p of sdkProjects) {
    const before = versionAt(mergeBase, p.dir);
    const after = versionAt(headSha, p.dir);
    if (before === null || after === null || before === after) continue;
    const path = changelogPath(p.dir);
    const problems = checkReleaseNotes(read(headSha, path) ?? '', after, { allowPending: true });
    for (const pr of problems) {
      error(`✗ ${p.name} ${printable(after)}: ${path}:${pr.line}: ${pr.message}`);
    }
    if (problems.length === 0) log(`Release ${p.name} ${after}: notes ok`);
    else ok = false;
  }

  log(
    `Changed files: ${changed.length}, ${files.length} after excluding tooling, tests and release edits`,
  );
  if (selected.length === 0) {
    log('No publishable package changed.');
    return ok;
  }

  const hatch = escapeHatch({ labels, body });
  if (hatch.used && !hatch.ok) {
    error(
      `✗ the "${ESCAPE_LABEL}" label needs a line "Changelog: none — <reason>" in the PR description`,
    );
    return false;
  }
  if (hatch.used) {
    log(`Entries not required (label "${ESCAPE_LABEL}"): ${hatch.reason}`);
    for (const s of selected) log(`  - ${s.name} (via ${printable(s.via)})`);
    return ok;
  }

  const missing = [];
  for (const s of selected) {
    const path = changelogPath(s.dir);
    const headText = read(headSha, path);
    if (headText !== null && entryAdded(read(mergeBase, path), headText)) {
      log(`  ✓ ${s.name} (via ${printable(s.via)}): entry added`);
    } else {
      missing.push(s);
      error(
        `  ✗ ${s.name} (via ${printable(s.via)}): no new line under "## [${UNRELEASED}]" in ${path}`,
      );
    }
  }
  if (missing.length > 0) {
    error(
      `✗ ${missing.length} package(s) changed without a changelog entry. Add a line under "## [${UNRELEASED}]", ` +
        `or, when there is nothing to announce, label the PR "${ESCAPE_LABEL}" and add "Changelog: none — <reason>" to its description.`,
    );
    return false;
  }
  return ok;
}
