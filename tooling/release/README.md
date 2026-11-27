# tooling/release

Plans and cuts the Go module tags for this repository.

Internal tooling. Never published itself: `tooling/` is excluded from every release.

## Purpose

A Go module in a subdirectory is published by a git tag prefixed with its directory —
`schemas/declarations/PaymentRequest/v1/bindings/go/v0.1.0`. There is no registry; the tag
*is* the publication, and a pushed tag is effectively permanent.

A release tags only the modules that need it:

- a module whose own files changed since its last tag (nested modules excluded — a change
  under `bindings/go/signing/` is not a change to `bindings/go/`);
- every module that depends on one being released, because otherwise consumers resolve it
  at a version whose `go.mod` still names the old dependency;
- every module that has never been tagged, at `v0.1.0`.

## Usage

Build it once from the repo root:

```bash
(cd tooling/release && go build -o /tmp/release .)
```

A release is three steps, because every merge to `main` is a squash:

**1. Plan** — see what would be released and why. Writes nothing.

```bash
/tmp/release plan
```

**2. Prepare** — rewrite the intra-repo `require` lines to the versions being published,
and commit them. Run on a branch, open a normal PR, merge it.

```bash
git switch -c release-requires
/tmp/release prepare
```

If no `require` line needs changing, `prepare` says so and makes no commit — skip to step 3.

**3. Tag** — on a clean checkout of `main`'s tip, after the prepare PR has merged:

```bash
git switch main && git pull && git fetch --tags
/tmp/release tag
```

`tag` creates the tags locally, runs `tooling/verify-standalone-modules.sh` against them —
resolving every module the way an outside consumer would — and only then prints the exact
`git push origin <tag> …` command. Pushing is deliberately left to you.

**Breaking changes.** Releases default to a patch bump. If anything since the last release is
breaking (a `feat!` or `fix!` commit), pass `-bump minor` to `plan`, `prepare` and `tag` alike.
`tag` only catches a mismatch through `require` lines, so a module nothing else requires gets
whatever `-bump` `tag` is given. Check the versions `tag` prints before you push.

## What `tag` refuses

- **A dirty tree** — unrelated edits would land on the tagged commit.
- **Requires not yet naming the planned versions** — the prepare PR has not merged.
- **Anything but origin's tip** — nothing else is sure to be in `main`'s history.
- **Tags that fail the standalone check** — they are deleted.

## When something goes wrong

- **"origin publishes N tag(s) this clone does not have"** — run `git fetch --tags`.
- **An interrupted `tag`** leaves local tags that were never checked or pushed. They are
  harmless: only tags on origin count as released, and the next run replaces them.
- **A tag pushed by mistake** must not be moved or deleted: consumers' `go.sum` pins its
  content. Publish a higher version instead, with a `retract` directive for the bad one in
  that version's `go.mod`.
