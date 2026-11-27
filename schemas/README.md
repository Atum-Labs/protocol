# Atum Protocol Schemas

The Atum Protocol is an identity-first crypto payments network protocol. Identity signing is the top concern: W3C VC holders sign payment requests, bids, bid selections, and fulfillment verifications.

These identity signatures cover not just the payment request details but the smart contract inputs too. This forms a signature within a signature and is what binds the off-chain identity to the on-chain transaction, enabling cryptographically verifiable audit trails. Because of this nesting the smart contract inputs are formally specified as typed messages (for example EIP-712) embedded within the identity signature input schema (for example JSON-LD), so a document canonicalizes deterministically before identity signing.

This directory defines two kinds of interface schema, one per subdirectory.

## `declarations/`

The identity-signing schemas. Each declaration pairs a JSON Schema file with a JSON-LD context file, which together form the input to W3C VC signing, alongside the hand-written signing and verification libraries (Go and TypeScript) that canonicalize and sign them. Declarations: `BidAward`, `BidAwardEnvelope`, `BidDecline`, `BidDeclineEnvelope`, `FulfillmentQuote`, `FulfillmentQuoteEnvelope`, `PaymentRequest`, `PaymentRequestEnvelope`, `SettlementResult`, `SettlementResultEnvelope`, plus the shared `common/ld-data-integrity` primitives.

## `apis/`

The interface definitions for the Atum network node types: hand-written OpenAPI `.yaml` files for HTTP APIs, a Protocol Buffers contract for `settler-gateway`'s bidirectional gRPC stream, plus the code bindings generated from each (Go server handlers, clients, and request/response structs, and TypeScript clients where applicable). APIs: `auth`, `counterparty-gateway` (registration and webhook), `error` (shared error components), `fulfillment-confirmation`, `payment-gateway`, `settler-gateway` (`session-stream` — gRPC), and `veri-fill`.

Not every API here is a public REST host. The writable list of public base URLs is [`apis/hosts.yaml`](apis/hosts.yaml) — see [Public API hosts](#public-api-hosts).

Smart contract encoding (EVM ABIs, Solana IDLs, EIP-712 and TIP-712 typed-message encoders, and their Go and TypeScript bindings) lives at the repo root under `contracts/`, not here.

### Shared shapes

Some of the types an API carries on the wire are the same types that get signed, and those
are defined once in `declarations/` rather than restated in each spec. Where an API serves
one of them, its `components.schemas` entry is generated from the declaration, so the shape
a client signs and the shape it sends cannot come apart.

The declarations do the same among themselves. A credential, a proof and a signed message
appear in most of them, and those shapes come from `declarations/common/shapes/v1`, so two
declarations cannot end up describing the same thing differently.

Anything that draws a shared shape keeps a `canonical-shapes.yaml` beside it, naming the
source and listing what it takes. Where it deliberately serves less than the source
defines, or constrains something further, that is listed there with the reason — so the
differences between a signed document and an HTTP body, or between one declaration and
another, are written down rather than left to be discovered.

For a client, the consequence is simple: `declarations/` is the authority on these types.
Where a spec could ever disagree with the declaration it draws from, the declaration is
what the signature is computed over.

Shapes are copied into a spec by generation rather than referenced across files with
`$ref`. The generators this repository targets do not all resolve cross-file references,
and the spec is also embedded whole for serving, so it has to stand on its own.

### Versioning

Every API is versioned directly under its name at `<name>/v1/`. A single-surface API puts its spec straight in that folder (`auth/v1/openapi.yaml`). A gateway that bundles several independent surfaces nests them under the version (`counterparty-gateway/v1/registration/openapi.yaml`, `counterparty-gateway/v1/webhook/openapi.yaml`). So the version segment always sits directly under the API name and a whole-gateway v2 has a clean home at `<name>/v2/`. The HTTP route prefix is uniform across every API at `/v1/...` (with `/health` left unversioned).

## Development

This directory builds a schema validator and generates and drift-checks the code bindings.

```bash
# Run all validations and drift guards
make lint

# Validate example.json files against their schemas
make validate-examples

# Regenerate code bindings
make generate

# Clean build artifacts
make clean
```

Key targets: `lint`, `verify-version`, `check-go-bindings`, `check-ts-bindings`, `check-api-bindings`, `check-canonical-shapes`, `check-conformance-fixtures`, `check-ld-verification-drift`, `check-hosts`, `test-hosts`, `check-host-literals`, `validate-examples`.

To change a shape an API draws from a declaration, edit the declaration and run `make generate-canonical-shapes`; the generated blocks are committed and `make check-canonical-shapes` verifies they still match.

## Public API hosts

[`apis/hosts.yaml`](apis/hosts.yaml) is the only file to edit when a public base URL changes. OpenAPI `servers:` blocks and the payment-gateway client's `defaultGateway` are generated from it. Do not hand-edit those outputs.

This file is **not** a list of every OpenAPI spec in `apis/`. It is the list of **public HTTP hosts** we publish to integrators:

| In `hosts.yaml` | Why |
| --- | --- |
| `payment-gateway` | Public Payment Gateway |
| `veri-fill` | Public fulfillment verifier |
| `auth` | Public auth host (not currently published on the docs site) |

x402 is not a row. It is the payment-gateway URL plus `x402_base_path` (`/x402/v1`). Wallet orchestration, settler-gateway, counterparty-gateway, and staging stay out — they are not public REST hosts for this list.

### Change a host

1. Edit the URL in `apis/hosts.yaml`.
2. Run `make generate-hosts` (also part of `make generate`).
3. Commit the yaml **and** the regenerated specs / `hosts.generated.ts` files (client + the two escrow trust lists).
4. `make check-hosts` must be a no-op. `make check-host-literals` must stay clean.

`payment-gateway.default_env` must stay `testnet`. The client `defaultGateway` is hardcoded to that env so a yaml typo cannot ship mainnet as the zero-config default. veri-fill and auth do not take `default_env`: OpenAPI `servers:` is always mainnet, then testnet, then local.

A leftover `atum.network` / `atumlabs.xyz` URL, or a `*.atum.xyz` service host that is not in this file, fails CI. `did:web:` issuers and `schemas.atum.*` JSON-LD identifiers are allowed; those are not REST hosts.

### Add a public API to the list

1. Add a block to `apis/hosts.yaml` (`spec`, `mainnet` / `testnet` / `local`). Only payment-gateway also has `default_env: testnet`.
2. Add the name to `API_ORDER` in `scripts/hosts.mjs`. The npm client only exports `defaultGateway` (payment-gateway testnet); do not add `hosts` or `x402BasePath` to the public surface.
3. Run `make generate-hosts` and `make test-hosts`.
4. If atum-docs should publish the spec, add it there as well (that repo's README, “Adding a published spec”).

## Tools

- Go for schema validation and JSON-LD processing.

### `replace` directives for a service consuming the Go bindings

```
replace github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go => ../schemas/apis/payment-gateway/v1/bindings/go
// add more binding paths as the consuming service needs them
```
