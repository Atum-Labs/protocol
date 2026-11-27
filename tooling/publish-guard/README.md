# @atum-labs/publish-guard

Shared release tooling for this repo's publishable npm packages: the pre-publish
guard, the third-party notices generator, and the entry-header stamper.

Private, dev-only workspace package. It is never a runtime dependency of anything
it guards, and never reaches a published tarball.

## Purpose

These checks are the last gate before a package is published, so they are
implemented once, shared by every publishable package, and covered by tests. A
single implementation means a package cannot be published under weaker checks than
its siblings, and the test suite means the checks cannot quietly stop detecting
while still reporting success.

## Usage

Each package keeps one-line scripts and a config file:

```json
"scripts": {
  "check:publishable": "node scripts/check-publishable.mjs",
  "gen:notices": "node scripts/gen-third-party-notices.mjs"
}
```

The `scripts/*.mjs` files are thin shims over this package. They stay at those
paths because CI and the publish workflow invoke them directly by path.

Package-specific inputs live in `<pkgRoot>/publish-guard.config.mjs`:

```js
export default {
  displayName: '@atumlabs/your-package',      // notices header
  externalDepsNote: 'as dependencies of …',   // verbatim; deps the notices do NOT cover
  requiredFiles: [...],                       // optional; defaults to LICENSE/README/NOTICES/package.json
  consumer: {
    moduleFormat: 'cjs' | 'esm',
    typeCheckLabel: 'default skipLibCheck',
    imports: { '.': ['SymbolA', 'SymbolB'] }, // symbols to type-check per entrypoint
    snippetFiles: ['readme-snippets.ts'],      // optional; TS files compiled against the tarball
    selfSpecifierAliases: ['@scope/name'],     // optional; import names rewritten to pkg.name
    subpaths: ['.'],                          // entrypoints to load at runtime
    extraInstalls: [],                         // extra npm specs the shipped .d.ts needs
    tsconfig: { /* compilerOptions */ },       // omit for tsc CLI defaults
  },
};
```

There is also a CLI, if you prefer it over the shims:

```
publish-guard check    [--cwd <packageRoot>]
publish-guard notices  [--cwd <packageRoot>]
publish-guard stamp    [--cwd <packageRoot>]
publish-guard changelog lint [--cwd <packageRoot>]
publish-guard changelog pr-check --base <ref> [--head <ref>]
publish-guard changelog release-check --ref <git ref> --dist-tag <tag> --package-name <name> [--cwd <packageRoot>]
publish-guard tag-release --package-name <name> --sha <commit> [--cwd <packageRoot>]
```

## Changelog lint

`publish-guard changelog lint` checks the package's `CHANGELOG.md` and prints each
problem as `path:line: message`:

- Line 1 is `# Changelog`, and the header links Keep a Changelog and Semantic
  Versioning before the first `##`.
- The first `##` section is `## [Unreleased]`; every other one reads
  `## [X.Y.Z] - YYYY-MM-DD` with a SemVer version and a real date. Versions appear
  once. Release dates are not checked for order.
- `###` headings are one of Added, Changed, Deprecated, Removed, Fixed, Security,
  Breaking, Migration.
- No `###` heading and no version section without content. An empty
  `## [Unreleased]` is valid: it is empty right after each release.

Headings inside fenced code blocks are content.

## Changelog entries on pull requests

`publish-guard changelog pr-check --base <ref> [--head <ref>]` runs on every pull
request to `main` (`.github/workflows/changelog.yml`). Run it from the repository
root. It reads the changes between the merge base of `--base` and `--head`
(default `HEAD`):

1. Changed files under `tooling/`, tests and test-runner configs, Go sources, the
   publishable packages' own `CHANGELOG.md` files, and `package.json` edits that
   change only `version` are ignored. A release PR therefore selects nothing.
2. Each remaining file belongs to the deepest workspace package that contains it.
   That package and every package that depends on it through `workspace:`
   dependencies are reached; the publishable ones among them (those with a
   `publish-guard.config.mjs` at the merge base or at the head) are selected. A
   `*.md` file or a file under `docs/` reaches only its own package. A file that a
   package's `src/` imports by relative path from outside the package (for example
   a JSON schema bundled into the build) also reaches that package and its
   dependents. A change to `pnpm-workspace.yaml` selects every publishable package.
3. Each selected package passes when its `CHANGELOG.md` gains a line under
   `## [Unreleased]`, or a new version section.

The output names each selected package and the file that selected it. Every
publishable package's changelog is also linted. Everything, the package graph
included, is read from the commits, so the result does not depend on what is
checked out.

A change with nothing to announce opts out with the `changelog: none` label plus a
line `Changelog: none — <reason>` in the PR description; the label alone fails. The
workflow passes the labels as `PR_LABELS` (a JSON array) and the description as
`PR_BODY`.

A PR that changes the `version` of a publishable package must also carry the
release notes for the new version, as `changelog release-check` describes below,
except that `## [Unreleased]` may keep entries next to a final version: a release
branch that merged `main` carries the next release's notes there. The
`changelog: none` label does not cover this.

## Release notes at publish time

`publish-guard changelog release-check --ref <git ref> --dist-tag <tag> --package-name <name>`
runs before a package is built and published. It reads `version` from the package's
`package.json`. A publish builds the whole commit, so the branch decides what
ships:

- A prerelease (`X.Y.Z-rc.N`) publishes only from an `rc/*` branch and never with
  the `latest` dist-tag, so that `npm install <pkg>` never installs it. It ships the
  notes under `## [Unreleased]`, which must have content, and `## [X.Y.Z]` must not
  exist yet.
- A final version `X.Y.Z` publishes only from a `release/*` branch. It needs its own
  `## [X.Y.Z] - YYYY-MM-DD` section with content, and an empty `## [Unreleased]`:
  an entry there is a change in the build that the version's notes do not describe.

The changelog must also pass `changelog lint`, and the tag `<name>-v<version>`
(see below) must be a ref name git accepts: SemVer allows `0.8.0-rc.lock`, git
refuses it, and the tag is only pushed after npm has published.

## Tagging a published version

`publish-guard tag-release --package-name <name> --sha <commit>` runs after a
successful publish, from the repository. It pushes the git tag
`<name>-v<version>` (version from the package's `package.json`) at `<commit>` to
`origin`, so every published version names the commit it was built from.

- A tag already at `<commit>` passes without a push, so re-running the tag job is
  safe.
- A tag at another commit fails and stays where it is.
- It refuses to push while `origin` has another ref whose name ends in
  `refs/tags/<name>-v<version>`: git matches ref names by suffix, so the push would
  update that ref instead of creating the tag.
- When the lookup or the push fails, it prints the command to tag by hand.

## What the guard enforces

1. No `@atum-labs/*` in runtime `dependencies` — siblings are bundled, dev-only.
2. No `@atum-labs/*` specifier left in the built `dist` — bundling did not leak.
3. No inlined copyleft dependency, and every inlined third-party package
   attributed in `THIRD-PARTY-NOTICES.txt`. Fails closed if the scan detects
   nothing (a minified build strips the pnpm store paths it reads).
4. The Apache-2.0 header is on every entry file and on **no** other dist file.
   Both directions matter: an unstamped entry is a licensing gap, and a stamped
   dependency chunk asserts Atum copyright over third-party source.
5. Tarball manifest: license materials present, internal templates absent,
   `license` field correct.
6. A real consumer type-check against the packed tarball.
7. A real runtime import/require of every published entrypoint.

Checks 1–5 are pure functions returning their failure messages, so each is
unit-testable without an npm round-trip. `checkPublishable` composes them and adds
6–7, which need a real pack and install.

## Entry derivation

Entry files come from the manifest — `main`, every `bin` target, and every `.js`
target in `exports` — not a hand-written list. That covers both package shapes
without special-casing:

| Package | Derived from | Entries |
| --- | --- | --- |
| `payment-gateway-client` | `main` + 4 `bin` CLIs | 5 |
| `mppx-atum-escrow` | `main` + `exports` (`./client`, `./server`) | 3 |
| `x402-atum-escrow` | `exports` only (`./client`, `./server`, `./facilitator`, `./fetch`) | 4 |

A new CLI or subpath export is stamped and checked automatically. A package with no
root entry at all is supported: "did you build?" is asked of the derived entries,
not of a fixed `dist/index.js`.

## Tests

```
pnpm --filter @atum-labs/publish-guard test
```

Every invariant has a failing-case fixture. The suite is verified by mutation:
neutering any single check makes at least one test fail.

## Adding a publishable package

Add `@atum-labs/publish-guard` as a `devDependency`, write a
`publish-guard.config.mjs`, and point `check:publishable` / `gen:notices` at the
shims. Do not copy the logic.
