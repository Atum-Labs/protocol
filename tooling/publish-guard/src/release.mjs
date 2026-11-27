// Publish-time check: may this package's version be published from this branch
// under this npm dist-tag, and does its changelog carry the notes for it?
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHANGELOG_FILENAME,
  checkReleaseNotes,
  lintChangelog,
  parseVersion,
} from './changelog.mjs';
import { releaseTag } from './tag.mjs';

// A publish builds the whole commit, so the branch decides what ships: a release
// branch freezes the code its notes describe, and main keeps moving.
export const RELEASE_BRANCH_PREFIX = 'release/';
export const PRERELEASE_BRANCH_PREFIX = 'rc/';

/**
 * Reads the version from `<pkgRoot>/package.json` and checks it against the git
 * `ref` being published (e.g. `refs/heads/release/sdks-2026-11-14`), the npm
 * `distTag` and `<pkgRoot>/CHANGELOG.md`. A final version publishes only from a
 * `release/*` branch and a prerelease only from an `rc/*` branch; a prerelease never
 * goes to `latest`, because `npm install <pkg>` would then install it. The changelog
 * must pass the format lint, and the tag `<packageName>-v<version>` must be a ref git
 * accepts: it is pushed only after npm has published. Returns true when it passes.
 *
 * @param {{
 *   pkgRoot: string, ref: string, distTag: string, packageName: string,
 *   log?: (m: string) => void, error?: (m: string) => void,
 * }} opts
 */
export function runReleaseCheck({
  pkgRoot,
  ref,
  distTag,
  packageName,
  log = console.log,
  error = console.error,
}) {
  const { name, version = '' } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  let ok = true;

  const parsed = parseVersion(version);
  if (parsed) {
    const prefix = parsed.prerelease ? PRERELEASE_BRANCH_PREFIX : RELEASE_BRANCH_PREFIX;
    if (!ref.startsWith(`refs/heads/${prefix}`)) {
      const kind = parsed.prerelease ? 'a prerelease' : 'a final version';
      error(
        `✗ ${name}@${version} is ${kind}: publish it from a branch named ${prefix}*, not ${ref}`,
      );
      ok = false;
    }
    if (parsed.prerelease && distTag === 'latest') {
      error(`✗ ${name}@${version} is a prerelease: publish it with dist_tag next, not latest`);
      ok = false;
    }
    const { tag, invalid } = releaseTag(packageName, version);
    if (invalid.length > 0) {
      error(
        `✗ ${name}@${version} cannot be tagged ${tag} after the publish: invalid ${invalid.join(', ')}`,
      );
      ok = false;
    }
  }

  const path = join(pkgRoot, CHANGELOG_FILENAME);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    error(`✗ ${path}: not found`);
    return false;
  }
  // Notes checks read the first [Unreleased]; the lint refuses a second one, among others.
  const problems = new Set(
    [...lintChangelog(text), ...checkReleaseNotes(text, version)].map(
      (p) => `✗ ${path}:${p.line}: ${p.message}`,
    ),
  );
  for (const p of problems) error(p);
  if (problems.size > 0) ok = false;

  if (ok) log(`✓ ${name}@${version} from ${ref} on dist-tag "${distTag}": release notes ok`);
  return ok;
}
