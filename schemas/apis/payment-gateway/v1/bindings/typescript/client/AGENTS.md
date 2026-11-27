# AGENTS.md

`@atumlabs/payment-gateway-client` — the TypeScript SDK and command-line tools for the Atum
Payment Gateway. Apache-2.0; see [`LICENSE`](./LICENSE).

This file is for people and agents working *on* the package, and is not shipped to npm. Read
[`CONTRIBUTING.md`](./CONTRIBUTING.md) first for install and build mechanics; this file covers
what that does not.

## Generated versus hand-written

Regenerate these; never hand-edit them.

| Path | Generated from | Regenerate with |
| --- | --- | --- |
| `src/generated/` | the payment-gateway OpenAPI contract | `pnpm --filter @atum-labs/payment-gateway-client run generate` |
| `src/hosts.generated.ts` | `schemas/apis/hosts.yaml` | `make -C schemas generate-hosts` |

`defaultGateway` is the only public host export. `hosts` / `x402BasePath` stay in the generated file for the build; they are not re-exported. The same generate writes trust-list `hosts.generated.ts` in mppx-atum-escrow and x402-atum-escrow.
| `THIRD-PARTY-NOTICES.txt` | the bundled dependency set | `pnpm gen:notices`, after a build |
| `dist/` | `src/` | `pnpm build` (untracked) |

Everything else under `src/` is hand-written, tests included. The contract itself lives at
`schemas/apis/payment-gateway/v1/openapi.yaml`: a client change that is really a contract change
starts there, then regenerates.

## Working on it

- `pnpm test` is the gate. It type-checks the whole of `src/` including the tests, then runs jest.
  There is no separate `typecheck` script, and no lint script yet.
- Run `pnpm run build:deps` before invoking `jest` directly. The suite resolves the in-repo
  `@atum-labs/*` packages from their compiled output, so a stale sibling build surfaces as a
  missing export rather than as a useful message.

## Writing for the outside world

This repository is public-facing and this package is published to external integrators. Assume every
comment, doc-comment and Markdown file here is read by a customer.

- **Write for someone integrating with Atum, not for someone who works here.** The test for a
  sentence is not "is it true?" but "does an integrator need this, and does it describe their side
  of the contract?" Where you would explain how we enforce something, say instead what they should
  do about it.
- **Doc comments on exported symbols ship.** TSDoc is emitted into `dist/*.d.ts` and shows on IDE
  hover, and `README.md` and `CHANGELOG.md` are both inside the npm tarball. Keep maintainer
  reasoning in `//` comments inside function bodies, which are not emitted.
- **Keep out** of comments, doc-comments and Markdown: ticket identifiers and issue links; pull
  request or code-review references; internal process, teams and people; implementation history
  ("this used to", "before the refactor", "the bug this prevents"); internal service, component and
  configuration or flag names; how our verification and fraud checks work; and endpoints or status
  codes belonging to anything not yet shipped.
- **Describe current behaviour and the reason for it** — never how it came to be that way.
- **Inherited text is not automatically safe.** A comment copied from elsewhere, or a description
  carried over from the contract, can contain any of the above. Re-read it rather than moving it.
- Every code example must be run against a real environment before it ships. Use a local cluster or
  staging, never production.

## Gotchas

- **Do not hand-edit the generated client.** Two CI jobs regenerate `src/generated/` and fail on
  any diff, and both run the same check: `make -C schemas check-pgc-openapi-client` in the
  `typescript` job, and `make -C schemas check-openapi-ts-clients` (that target plus the veri-fill
  one) in `schema-guards`. It covers the whole directory, so `core/` and `PaymentGatewayClient.ts`
  count too, and it fails on a newly emitted file as well as a changed one. The comparison lives in
  `schemas/Makefile`, which is why grepping the workflows for the file names finds nothing. A hand
  edit is overwritten on the next run, so no test can defend it either.
- **Chain adapters, sender-auth schemes and signer internals are private.** They are not exported
  from `src/index.ts` and are free to change between releases. Consumers build a request with
  `preparePaymentRequest` and sign it with `signPaymentRequest`. If unsure whether a symbol is
  public, check the built `dist/index.d.ts` rather than the source.
- **Never edit a conformance or parity vector to make a test pass.** The vectors are frozen and
  shared with the Go implementation, so a failure means an encoder changed and the two languages
  no longer agree on the bytes. Fix the encoder. See
  [`../../../../../../../contracts/encoding-parity.md`](../../../../../../../contracts/encoding-parity.md).
- **Base58 is case-significant.** Never lowercase a Solana chain reference, token mint or account
  address, and never case-fold an asset identifier wholesale. EVM hex addresses are the only part
  that may be compared case-insensitively.
- **`request_id` is required, and the SDK never invents one.** It is the idempotency key and it
  seeds the on-chain deposit nonce, so generating one on a caller's behalf would turn a retry into
  a second payment.
- **Do not bump `version` in `package.json`.** It tracks the last published release. Describe
  consumer-visible changes under `## [Unreleased]` in `CHANGELOG.md`, in the same change that
  makes them. Publishing is a separate branch that bumps the version and promotes `[Unreleased]`
  to a dated heading — see *Changelog and releasing* in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
  A feature branch that bumped the version would release everyone else's pending entries under
  its own number.
- **Adding a public export?** `publish-guard.config.mjs` lists the symbols a consumer must be able
  to import from the packed tarball; `pnpm run check:publishable` packs it, installs it into a
  throwaway project and type-checks against it.
- **Editing a TypeScript block in `README.md`? Update `readme-snippets.ts` in the same change.**
  That file is compiled against the packed tarball by `pnpm run check:publishable`, so it is what
  stops a documented example drifting from the published types. It is guard input only: not in
  `src/`, not in `files`, and shipped to nobody.

## Conventions

- TypeScript, strict. The build is CJS via tsup, targeting Node 18.
- No `@atum-labs/*` package may appear in runtime `dependencies`. Siblings are devDependencies and
  are bundled into `dist`, so an installed package pulls only public registry packages.
- Comments explain why something is the way it is, not what the line does.
- No emojis anywhere: code, comments, documentation or commit messages.
