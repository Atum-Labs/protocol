# Cryptosuite contexts (vendored)

This directory holds canonical, vendored copies of the W3C JSON-LD contexts
that signed FulfillmentQuotes reference. Each `<suite>/<version>.jsonld` file mirrors
the W3C URL structure (e.g. `secp256k1recovery-2020/v2.jsonld` → `https://w3id.org/security/suites/secp256k1recovery-2020/v2`).

## Why vendored

The signing/verification libraries
(`schemas/declarations/FulfillmentQuote/v1/bindings/{go,typescript}/ld-{verification,signing}/`)
use a strict-no-network JSON-LD document loader: any context URL the signer/verifier
canonicalizes against must be present in their embedded snapshot map, or canonicalization
fails. That is deliberate — it prevents an attacker who controls a quote payload from
forcing the verifier to issue HTTP GETs to arbitrary URLs from inside its container's
network namespace (cloud metadata, internal services) on the pre-auth verify hot path.

Since the libraries cannot fetch contexts at runtime, they bundle them at build time.
This directory is the single source of truth those bundles snapshot from.

## Updating

If a cryptosuite context needs to change (rare — these are W3C-pinned), update the
`.jsonld` file here and run `make update-ld-contexts` from the repo root. That target
propagates the new content into each lib's `contexts/` (Go) or `dist/contexts/` (TS via
`prebuild`) snapshot directory. CI's `verify-context` step in each lib's `lint` will
fail if the snapshots drift from the source.

## What lives here

| Path | URL it represents | Consumers |
| --- | --- | --- |
| `secp256k1recovery-2020/v2.jsonld` | `https://w3id.org/security/suites/secp256k1recovery-2020/v2` | `EcdsaSecp256k1RecoverySignature2020` proofs (EVM + Tron settlers) |
