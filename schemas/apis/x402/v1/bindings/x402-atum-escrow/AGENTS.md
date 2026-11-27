# AGENTS.md

`@atumlabs/x402-atum-escrow` — the atum-escrow scheme mechanisms for x402: client (payer), server
(resource server), facilitator, and a `fetch` wrapper. Apache-2.0; see [`LICENSE`](./LICENSE).

This file is for people and agents working *on* the package, and is not shipped to npm.

## Layout

One entry point per role, and **deliberately no root entry** — importing the package name alone must
not pull another role's code, so a payer never ships the facilitator's logic:

| Import | Source | For |
| --- | --- | --- |
| `@atumlabs/x402-atum-escrow/client` | `src/client/` | the payer |
| `@atumlabs/x402-atum-escrow/server` | `src/server/` | the resource server building a 402 |
| `@atumlabs/x402-atum-escrow/facilitator` | `src/facilitator/` | the facilitator |
| `@atumlabs/x402-atum-escrow/fetch` | `src/fetch/` | the payer's `fetch` wrapper |

Adding a root entry, or importing across roles, silently undoes that separation. Keep the boundary.

`src/hosts.generated.ts` is generated from `schemas/apis/hosts.yaml` (`make -C schemas generate-hosts`).
Do not edit it. Everything else under `src/` is hand-written. Two other artefacts are produced and
must not be hand-edited — `dist/` (`pnpm build`) and `THIRD-PARTY-NOTICES.txt` (`pnpm gen:notices`,
after a build).

## Working on it

- `pnpm test` is the gate: it type-checks the tests, then runs vitest. `pnpm typecheck` checks the
  source on its own.
- Build the dependency closure before invoking `vitest` directly:
  `pnpm --filter "@atum-labs/x402-atum-escrow..." run build` (the trailing `...` includes the siblings). The in-repo
  `@atum-labs/*` packages resolve from their compiled output, and some shared logic is inlined into
  more than one sibling bundle, so a partially rebuilt tree fails as a wrong value in an assertion
  rather than as anything that mentions the build.
- `pnpm run check:publishable` packs the tarball, installs it into a throwaway project and
  type-checks every documented import against it, one entry point at a time.

## Writing for the outside world

This repository is public-facing and this package is published to external integrators. Assume
every comment, doc-comment and Markdown file here is read by a customer.

- **Write for a merchant, payer or facilitator integrating with Atum, not for someone who works
  here.** The test for a sentence is not "is it true?" but "does an integrator need this, and does
  it describe their side of the contract?" Where you would explain how we enforce something, say
  instead what they should do about it.
- **Doc comments on exported symbols ship.** They are emitted into `dist/*.d.ts` and show on IDE
  hover, and `README.md` and `CHANGELOG.md` are both inside the npm tarball. Keep maintainer
  reasoning in `//` comments inside function bodies, which are not emitted.
- **Keep out** of comments, doc-comments and Markdown: ticket identifiers and issue links; pull
  request or code-review references; internal process, teams and people; implementation history
  ("this used to", "before the refactor", "the bug this prevents"); internal service, component and
  configuration or flag names; how our verification and fraud checks work; and endpoints or status
  codes belonging to anything not yet shipped.
- **Describe current behaviour and the reason for it** — never how it came to be that way.
- **Inherited text is not automatically safe.** A comment copied from elsewhere can contain any of
  the above. Re-read it rather than moving it.
- Every code example must be run against a real environment before it ships. Use a local cluster or
  staging, never production.

## Gotchas

- **The destination identifier is derived exactly once and carried verbatim.** The same string goes
  into the signed witness and into the request body, and the release and refund signers read it back
  rather than re-deriving it. A second derivation site is how deposits get stranded, so never
  recompute the destination — pass the value through. `src/client/sender-signer.test.ts` pins this.
- **Do not normalise or case-fold an asset identifier wholesale.** Base58 values are
  case-significant: never lowercase a Solana chain reference, token mint or account address. Only
  EVM hex may be compared case-insensitively, and Tron role addresses go through the shared
  `normalizeAddress` rather than an ad-hoc conversion.
- **Do not reimplement the escrow encoders.** Encoding comes from the shared
  `@atum-labs/*-escrow-encoding` packages, whose output is pinned by frozen cross-language vectors.
  If a change appears to need different bytes, fix it in the encoder rather than working around it
  here; see [`contracts/encoding-parity.md`](../../../../../../contracts/encoding-parity.md).
- **No `@atum-labs/*` package may appear in runtime `dependencies`.** Siblings are devDependencies
  and are bundled into `dist`, so an installed package pulls only public registry packages.
  `check:publishable` enforces this on both the manifest and the built output, and the notices file
  is currently all-permissive — keep it that way.
- **Do not bump `version` in `package.json`.** It tracks the last published release. Describe
  consumer-visible changes under `## [Unreleased]` in `CHANGELOG.md`, in the same change that
  makes them. Publishing is a separate branch that bumps the version and promotes `[Unreleased]`
  to a dated heading — see *Changelog and releasing* in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
  A feature branch that bumped the version would release everyone else's pending entries under
  its own number.
- **Adding or renaming a public export?** `publish-guard.config.mjs` lists the symbols a consumer
  must be able to import from each entry point; update it in the same change.

## Conventions

- TypeScript, strict. The build is ESM via tsup, targeting Node 18.
- Comments explain why something is the way it is, not what the line does.
- No emojis anywhere: code, comments, documentation or commit messages.
