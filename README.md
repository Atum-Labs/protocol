# Atum Protocol

The source of truth for Atum's shared interfaces: the signed message declarations, service API
definitions, on-chain escrow encoding, and custody signing that Atum participants have in common.
Consumers depend on these definitions rather than reimplementing them.

## Layout

```
schemas/               Protocol message + API definitions and their generated Go/TypeScript bindings
  declarations/        Signed message types (PaymentRequest, QuoteRequest, FulfillmentQuote, BidAward, …)
    common/            Primitives shared across declarations (W3C Data Integrity, cryptosuite
                       contexts, chain-address account validation)
  apis/                OpenAPI service interface definitions
contracts/             On-chain contract sources and their encoders, per virtual machine (evm, svm, tvm)
  <chain>/source/        Vendored contract source, pinned to a commit of the upstream contract repo
  <chain>/bindings/{go,typescript}/escrow-encoding/  Signing-input encoders with cross-language parity tests
  <chain>/conformance/  Frozen cross-language parity vectors
  <chain>/docker/      Local chain stack for that virtual machine
  <chain>/deployments-v*.json  Deployed contract addresses per environment
  <chain>/deploy/      Operator deployment tooling + a step-by-step guide for that VM
  deploy/              Cross-VM: bootstrap.sh (set up a fresh clone), verify-all.sh
                       (every check, EVM -> TVM -> SVM), and the deployment index README
key-management/        Custody signing
  common/typescript/   Shared signer interface package (@atum-labs/km-core) — Signer<T>, chain
                       primitives, signing-policy shape, error types
  providers/turnkey/   Turnkey provider: Go signer (go/) + TS provider (typescript/,
                       @atum-labs/turnkey-signer) built on the shared interface

Publishable SDKs — each bundles its in-repo siblings so it installs standalone:
schemas/apis/payment-gateway/v1/bindings/typescript/client/
                         Gateway client + CLIs (@atumlabs/payment-gateway-client)
schemas/apis/payment-gateway/v1/bindings/typescript/mppx-atum-escrow/
                         Atum escrow payment method for MPP (@atumlabs/mppx-atum-escrow)
schemas/apis/x402/v1/bindings/x402-atum-escrow/
                         The atum-escrow x402 scheme mechanisms — client, server,
                         facilitator, fetch (@atumlabs/x402-atum-escrow)

tooling/publish-guard/   Shared pre-publish guard, third-party notices generator, and
                         entry-header stamper used by all three
```

## Building

`pnpm install` links the workspace and compiles every package, so a fresh clone is ready
to work in. From then on, `pnpm -r build` and `pnpm -r test` build and test everything in
dependency order.

The three publishable SDKs bundle their in-repo siblings, so they need those siblings
compiled before they can build, type-check or test. None of their scripts compiles a
sibling on your behalf: doing that from inside each package meant the same sibling was
compiled once per consumer, with concurrent writers landing in one `dist`. Instead, ask
pnpm for the package together with its dependencies — the trailing `...` is what adds
them:

```bash
pnpm --filter "@atum-labs/mppx-atum-escrow..." build     # the package AND its dependencies
pnpm --filter "@atum-labs/mppx-atum-escrow^..." build    # only its dependencies (this is `build:deps`)
```

Each member is compiled exactly once, in dependency order.

This matters after `pnpm run clean`, which removes the siblings' `dist` alongside the
package's own. A bare `build`, `typecheck`, `typecheck:tests` or `test` will then fail on
missing `@atum-labs/*` modules. Rebuild the closure first:

```bash
pnpm --filter "@atum-labs/mppx-atum-escrow..." build && pnpm --filter @atum-labs/mppx-atum-escrow test
```

CI is unaffected: it runs `pnpm -r build` before `pnpm -r test`.

## Releasing the npm SDKs

The three SDKs are published by their publish workflows, from a `release/*` branch for a
release and an `rc/*` branch for a release candidate. [RELEASING.md](./RELEASING.md) has
the steps.

## Releasing Go modules

Each Go module is published by a tag prefixed with its directory. Cut releases with
[`tooling/release`](./tooling/release/README.md), which tags only the modules that changed
(plus everything depending on them) and verifies the tags resolve before offering the push.

## Reading the Go docs

The Go documentation is the source comments. From any package's directory:

```bash
go doc .          # this package, in the terminal
go doc -http .    # the whole module, rendered in a browser
```

## Rules

- **Self-contained.** This repository depends only on third-party packages (the contract sources
  under `contracts/<chain>/repo` are vendored at a pinned commit, and Foundry deps stay as
  submodules). It never depends on the services that consume it, so there are no circular
  dependencies.
- **Languages are co-located.** Each unit holds its own `go/` and `typescript/` side by side; there
  is no top-level per-language folder.
- **Bindings are generated and committed.** Types are generated from the schema and OpenAPI sources;
  the committed output is drift-guarded in CI (regenerate, then fail on any diff).
- **Cross-language encoders are proven equal.** Where a value is encoded in more than one language
  (for example the escrow reserve digest in Go and TypeScript), every implementation is tested
  against the same frozen vector file, so a one-byte divergence fails CI.
- **Definitions are versioned.** Messages and APIs carry an explicit version (`v1`, …), and each
  version constant is checked against its schema in CI.

## License

This repository is licensed under the [Apache License, Version 2.0](./LICENSE).
Protocol is what integrators implement against; the express patent grant is why
this repo is Apache-2.0 rather than MIT. Example apps that exist to be copied
live in [`Atum-Labs/examples`](https://github.com/Atum-Labs/examples) under MIT.

The on-chain contract sources stay MIT. [LICENSING.md](./LICENSING.md) is the
path map, including vendored third-party under `contracts/*/source/lib`.
