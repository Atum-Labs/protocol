// After a publish: the git tag <package_name>-v<version> records which commit each
// published version was built from.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseVersion } from './changelog.mjs';

const COMMIT = /^[0-9a-f]{40}$/;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

function isValidRef(ref) {
  try {
    execFileSync('git', ['check-ref-format', ref], { stdio: 'ignore' });
    return true;
  } catch (e) {
    if (e.status === 1) return false;
    throw e;
  }
}

/**
 * The git tag `<packageName>-v<version>` that records a published version, its full
 * ref, and what makes it invalid (empty when git accepts it). Valid SemVer can still
 * be a ref git refuses, e.g. `0.8.0-rc.lock`.
 *
 * @param {string} packageName
 * @param {string} version
 * @returns {{ tag: string, ref: string, invalid: string[] }}
 */
export function releaseTag(packageName, version) {
  const tag = `${packageName}-v${version}`;
  const ref = `refs/tags/${tag}`;
  const invalid = [
    !PACKAGE_NAME.test(packageName ?? '') && `package name ${JSON.stringify(packageName)}`,
    !parseVersion(version) && `version ${JSON.stringify(version)}`,
  ].filter(Boolean);
  if (invalid.length === 0 && !isValidRef(ref)) {
    invalid.push(`tag ${JSON.stringify(tag)}, which git refuses as a ref name`);
  }
  return { tag, ref, invalid };
}

/**
 * Pushes the tag `<packageName>-v<version>` (version from `<pkgRoot>/package.json`)
 * at commit `sha` to `origin`. A tag already at `sha` counts as done, so a re-run is
 * safe. A tag at another commit fails: that version was already published from
 * there. Git runs in `cwd`. Returns true when the tag is in place at `sha`.
 *
 * @param {{
 *   pkgRoot: string, packageName: string, sha: string, cwd?: string,
 *   log?: (m: string) => void, error?: (m: string) => void,
 * }} opts
 */
export function tagRelease({
  pkgRoot,
  packageName,
  sha,
  cwd = process.cwd(),
  log = console.log,
  error = console.error,
}) {
  const { version } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const { tag, ref, invalid } = releaseTag(packageName, version);
  if (!COMMIT.test(sha ?? '')) invalid.push(`commit ${JSON.stringify(sha)}`);
  if (invalid.length > 0) {
    error(`✗ cannot tag: invalid ${invalid.join(', ')}`);
    return false;
  }

  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const refs = git('ls-remote', 'origin', ref, `${ref}^{}`)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'));
    // ls-remote and push both match a ref by path suffix, so a push would update a
    // ref such as refs/heads/refs/tags/<tag> instead of creating the tag.
    const lookalike = refs.find(([, name]) => name !== ref && name !== `${ref}^{}`);
    if (lookalike) {
      error(`✗ cannot tag: origin has ${lookalike[1]}, which a push of ${ref} would update`);
      return false;
    }
    // An annotated tag lists its commit on the ^{} line, which comes last.
    const tagged = refs.at(-1)?.[0];
    if (tagged === sha) {
      log(`✓ tag ${tag} is already on ${sha}`);
      return true;
    }
    if (tagged) {
      error(
        `✗ tag ${tag} points at ${tagged}, not at ${sha}, the commit this run published; find out which commit ${packageName}@${version} was built from before moving the tag`,
      );
      return false;
    }
    git('push', 'origin', `${sha}:${ref}`);
  } catch (e) {
    error(`✗ ${e.stderr?.trim() || e.message}`);
    error(
      `✗ published ${packageName}@${version} from ${sha} but did not tag it. Re-run the failed jobs (the publish is not repeated), or tag it by hand: git push origin ${sha}:${ref}`,
    );
    return false;
  }
  log(`✓ pushed tag ${tag} at ${sha}`);
  return true;
}
