# Contributing to mppx-atum-escrow

This file lives in the repo for developers with access. It is not shipped in the
published npm package.

mppx-atum-escrow lives inside the protocol monorepo. To work on it from source:

```bash
git clone https://github.com/Atum-Labs/protocol.git
cd protocol

# Install the workspace with pnpm. This builds mppx-atum-escrow and its in-repo
# dependencies (the escrow encoders, sender-auth, payment-gateway-client) via the workspace:
pnpm install
```

See also [`AGENTS.md`](./AGENTS.md) for the conventions this package follows and the
mistakes that are easy to make in it.

## In-repo dependencies

The shared `@atum-labs/*` libraries under `contracts/`, `schemas/` and the sibling
`payment-gateway-client` are workspace members, consumed as `workspace:*`. A root
`pnpm install` links *and* compiles them, so a fresh clone is ready to build.

`pnpm run build`, `pnpm test` and `pnpm typecheck` all compile only this package, on the
assumption its siblings are already built — none of them builds a sibling for you. Build
the siblings and this package together by asking pnpm for the whole dependency closure
(the trailing `...` is what includes it):

```bash
pnpm --filter "@atum-labs/mppx-atum-escrow..." build
```

`pnpm run build:deps` compiles just the siblings, without this package. Both derive the
sibling list from `dependencies`/`devDependencies`, so there is no path list to keep in
step by hand.

This matters more here than it looks. Some shared logic is bundled into more than one
sibling, so a partially rebuilt tree does not fail with a missing module — it fails as a
wrong value inside an assertion, with nothing in the message about the build. If a test
starts disagreeing about a derived value you did not touch, rebuild the closure before
looking anywhere else. The same applies after `pnpm run clean`, which removes the
siblings' `dist` too. See the repository README's "Building" section for the full picture.

They are `devDependencies` on purpose. The build bundles them directly into `dist/`, so
the published package is self-contained and declares no `@atum-labs/*` runtime dependency
— a consumer installs only real registry packages. Third-party libraries stay external and
are installed normally.

## Peer dependencies

This package is an `mppx` plugin, so `mppx` and `zod` are **peer** dependencies: it
registers into the consumer's own `mppx` instance and must share the same copy of both.
Do not move either into `dependencies` — two copies of `zod` in one process produce schema
failures that are hard to diagnose from the error alone.

`@solana/web3.js` is a runtime dependency *and* is marked `external` in `tsup.config.ts`,
so consumers install it rather than receiving a bundled copy. Keep it that way: bundling
it would redistribute its transitive copyleft dependency inside our artifact.

## Before you open a pull request

```bash
# From the repository root, so every line works from one place.
pnpm --filter "@atum-labs/mppx-atum-escrow..." build
pnpm --filter @atum-labs/mppx-atum-escrow test
pnpm --filter @atum-labs/mppx-atum-escrow run check:publishable
```

`check:publishable` packs the real tarball, installs it into a throwaway project,
type-checks it and runs it, and fails if a workspace sibling leaked into the published
output. See `tooling/publish-guard` for the full set of checks, and regenerate
`THIRD-PARTY-NOTICES.txt` with `pnpm gen:notices` whenever the bundled dependency set
changes.

## Changelog and releasing

Every consumer-visible change is described under `## [Unreleased]` in `CHANGELOG.md`, in the same
change that makes it. **Do not touch `version` in `package.json`** — it names the last published
release, not the one being worked on.

Publishing is its own change, on its own `release/*` branch, doing nothing else:

1. Bump `version` in `package.json`.
2. Rename `## [Unreleased]` to `## [<version>] - <YYYY-MM-DD>`.
3. Add a fresh, empty `## [Unreleased]` above it.
4. Publish from that branch, then merge.

Release candidates go out from an `rc/*` branch to the `next` dist-tag.
[RELEASING.md](../../../../../../RELEASING.md) walks through both, and the publish workflow refuses
a release that does not follow them.

Keeping the two apart is what makes a feature branch safe to merge whenever it is ready.
`[Unreleased]` accumulates entries from several changes at once, so a feature branch that bumped
the version would publish everyone else's pending entries under its own number — and a feature
that is reverted would leave a version number behind that was never released.
