# Contributing to payment-gateway-client

This file lives in the repo for developers with access. It is not shipped in the
published npm package.

payment-gateway-client lives inside the protocol monorepo. To work on it from source:

```bash
git clone https://github.com/Atum-Labs/protocol.git
cd protocol

# Install the workspace with pnpm. This builds payment-gateway-client and its
# in-repo deps (km-core, turnkey-signer, solana-escrow-encoding) via the workspace:
pnpm install

# (Optional) expose the CLI globally:
cd schemas/apis/payment-gateway/v1/bindings/typescript/client && pnpm link --global
```

See also [`AGENTS.md`](./AGENTS.md) for the conventions this package follows and the
mistakes that are easy to make in it.

## In-repo dependencies

The shared `@atum-labs/*` libraries under `key-management/`, `contracts/` and
`schemas/` are workspace members, consumed as `workspace:*`. A root `pnpm install`
links *and* compiles them, so a fresh clone is ready to build.

`pnpm run build`, `pnpm test` and `pnpm run typecheck:tests` all compile only this
package, on the assumption its siblings are already built — none of them builds a
sibling for you. Build the siblings and this package together by asking pnpm for the
whole dependency closure (the trailing `...` is what includes it):

```bash
pnpm --filter "@atum-labs/payment-gateway-client..." build
```

`pnpm run build:deps` compiles just the siblings, without this package. Both derive the
sibling list from `dependencies`/`devDependencies`, so there is no path list to keep in
step by hand.

This matters after `pnpm run clean`, which removes the siblings' `dist` too: a bare
`build`, `test` or `typecheck:tests` then fails on missing `@atum-labs/*` modules. Run
the closure build first. See the repository README's "Building" section for the full
picture.

They are `devDependencies` on purpose. The build bundles them directly into
`dist/`, so the published package is self-contained and declares no `@atum-labs/*`
runtime dependency — a consumer installs only real registry packages. Third-party
libraries stay external and are installed normally.

`pnpm run check:publishable` enforces that: it packs the tarball, installs it into
a throwaway project, type-checks and runs it, and fails if a workspace sibling
leaked into the published output. See `tooling/publish-guard` for the full set of
checks, and regenerate `THIRD-PARTY-NOTICES.txt` with `pnpm gen:notices` whenever
the bundled dependency set changes.

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
