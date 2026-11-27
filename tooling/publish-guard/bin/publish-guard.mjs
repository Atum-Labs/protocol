#!/usr/bin/env node
// Shared entrypoint for the publishable packages' release tooling.
//
//   publish-guard check    pre-publish invariants (run after build)
//   publish-guard notices  regenerate THIRD-PARTY-NOTICES.txt (run after build)
//   publish-guard stamp    stamp the Apache-2.0 header on entry files (run after tsup)
//   publish-guard changelog lint   check CHANGELOG.md against the Keep a Changelog rules
//   publish-guard changelog pr-check --base <ref> [--head <ref>]
//                          require a changelog entry for each publishable package a
//                          change reaches (run from the repository root)
//   publish-guard changelog release-check --ref <git ref> --dist-tag <tag> --package-name <name>
//                          check the package.json version against the branch, the
//                          npm dist-tag, the changelog and the release tag (run before publish)
//   publish-guard tag-release --package-name <name> --sha <commit>
//                          push git tag <name>-v<version> at the published commit (run after publish)
//
// Runs against the current working directory's package by default, so each
// package's scripts stay one-liners. `--cwd <dir>` targets another package.
import { checkPublishable } from '../src/check.mjs';
import { generateNotices } from '../src/notices.mjs';
import { stampEntryHeaders } from '../src/stamp.mjs';
import { loadConfig } from '../src/config.mjs';
import { parseArgs } from 'node:util';
import { lintChangelogFile } from '../src/changelog.mjs';
import { runPrCheck } from '../src/changelog-pr.mjs';
import { runReleaseCheck } from '../src/release.mjs';
import { tagRelease } from '../src/tag.mjs';

const USAGE = [
  'usage: publish-guard <check|notices|stamp|changelog lint> [--cwd <packageRoot>]',
  '       publish-guard changelog pr-check --base <ref> [--head <ref>] [--cwd <repo>]',
  '       publish-guard changelog release-check --ref <git ref> --dist-tag <tag> --package-name <name> [--cwd <packageRoot>]',
  '       publish-guard tag-release --package-name <name> --sha <commit> [--cwd <packageRoot>]',
].join('\n');

let args;
try {
  args = parseArgs({
    options: {
      cwd: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      ref: { type: 'string' },
      'dist-tag': { type: 'string' },
      'package-name': { type: 'string' },
      sha: { type: 'string' },
    },
    allowPositionals: true,
  });
} catch (e) {
  console.error(`${e.message}\n${USAGE}`);
  process.exit(2);
}
const [command, subcommand] = args.positionals;
const pkgRoot = args.values.cwd ?? process.cwd();

/** PR labels as a JSON array of names (the workflow passes toJSON of the label names). */
function prLabels() {
  const raw = process.env.PR_LABELS;
  if (!raw) return [];
  const labels = JSON.parse(raw);
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) {
    throw new Error('PR_LABELS must be a JSON array of label names');
  }
  return labels;
}

try {
  switch (command) {
    case 'check': {
      const cfg = await loadConfig(pkgRoot);
      const ok = checkPublishable({
        pkgRoot,
        consumer: cfg.consumer,
        requiredFiles: cfg.requiredFiles,
      });
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'notices': {
      const cfg = await loadConfig(pkgRoot);
      generateNotices({
        pkgRoot,
        displayName: cfg.displayName,
        externalDepsNote: cfg.externalDepsNote,
      });
      break;
    }
    case 'stamp': {
      stampEntryHeaders({ pkgRoot });
      break;
    }
    case 'changelog': {
      if (subcommand === 'lint') {
        process.exit(lintChangelogFile(pkgRoot) ? 0 : 1);
      }
      if (subcommand === 'pr-check' && args.values.base) {
        const ok = runPrCheck({
          cwd: pkgRoot,
          base: args.values.base,
          head: args.values.head,
          labels: prLabels(),
          body: process.env.PR_BODY ?? '',
        });
        process.exit(ok ? 0 : 1);
      }
      if (
        subcommand === 'release-check' &&
        args.values.ref &&
        args.values['dist-tag'] &&
        args.values['package-name']
      ) {
        const ok = runReleaseCheck({
          pkgRoot,
          ref: args.values.ref,
          distTag: args.values['dist-tag'],
          packageName: args.values['package-name'],
        });
        process.exit(ok ? 0 : 1);
      }
      console.error(USAGE);
      process.exit(2);
      break;
    }
    case 'tag-release': {
      if (!args.values['package-name'] || !args.values.sha) {
        console.error(USAGE);
        process.exit(2);
      }
      const ok = tagRelease({
        pkgRoot,
        packageName: args.values['package-name'],
        sha: args.values.sha,
      });
      process.exit(ok ? 0 : 1);
      break;
    }
    default:
      console.error(USAGE);
      process.exit(2);
  }
} catch (e) {
  console.error('✗ ' + (e?.message ?? e));
  process.exit(1);
}
