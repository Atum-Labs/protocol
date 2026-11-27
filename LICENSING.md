# Licensing

This repository is [Apache-2.0](./LICENSE) unless a path below says otherwise.
Copyright is stated in [NOTICE](./NOTICE).

Protocol is what integrators implement against; the express patent grant is why
the default is Apache-2.0 rather than MIT. Example apps that exist to be copied
live in [`Atum-Labs/examples`](https://github.com/Atum-Labs/examples) under MIT.

## Atum-authored exceptions

On-chain contract sources stay MIT. That matches the SPDX headers on the
Solidity and the grant in force when v1–v4 were deployed and verified. The next
major contract version is the clean boundary if those sources should move to
Apache-2.0.

| Path | License |
| --- | --- |
| `contracts/evm/source` (Atum `.sol`, not `lib/`) | MIT |
| `contracts/tvm/source` (Atum `.sol`, not `lib/`) | MIT |
| `contracts/svm/source` (Atum programs under `programs/`) | MIT |

Everything else Atum-authored — schemas, bindings, encoders, SDKs, key-management,
tooling — is Apache-2.0.

## Vendored third-party

These keep their upstream licenses. Do not restamp them.

| Path | License |
| --- | --- |
| `contracts/evm/source/lib/forge-std` | Apache-2.0 OR MIT |
| `contracts/tvm/source/lib/forge-std` | MIT OR Apache-2.0 |
| `contracts/evm/source/lib/permit2` | MIT |
| `contracts/evm/source/lib/permit2/lib/openzeppelin-contracts` | MIT |

Other files under `contracts/*/source/lib` keep the license on the file or in
that tree's own `LICENSE`.
