# Solana Escrow Documentation

Multi-party escrow program on Solana using off-chain Ed25519 signatures for authorization.

## Documentation

| Topic                                                  | Description                                 |
| ------------------------------------------------------ | ------------------------------------------- |
| **Getting Started**                                    |                                             |
| [Quickstart](getting-started/quickstart.md)            | Get running in 5 minutes                    |
| [Configuration](getting-started/configuration.md)      | Program IDs and setup                       |
| **Programs**                                           |                                             |
| [Escrow](programs/escrow.md)                           | Delegate, deposit, reserve, release, refund |
| [Fulfillment Proxy](programs/fulfillment-proxy.md)     | Token transfer with replay protection       |
| **Architecture**                                       |                                             |
| [Overview](architecture/overview.md)                   | System design and escrow flow               |
| [Security](architecture/security.md)                   | Ed25519 verification, account validation    |
| [Replay Protection](architecture/replay-protection.md) | Bitmap-based duplicate prevention           |
| [PDA Support](architecture/pda-support.md)             | Program Derived Address integration         |
| **Development**                                        |                                             |
| [Setup](development/setup.md)                          | Local environment                           |
| [Testing](development/testing.md)                      | Running tests                               |
| [Contributing](development/contributing.md)            | Guidelines                                  |
| **Operations**                                         |                                             |
| [Deployment](operations/deployment.md)                 | Local to mainnet                            |

## Program IDs

| Program           | ID                                             |
| ----------------- | ---------------------------------------------- |
| Escrow            | `F9mjwmRfYWVUJPwSm3ygG7c9Pq2JF2eqpHC6MpVffV85` |
| Fulfillment Proxy | `679cgQsBfvGLbeJutpRmJvEZtx5pWsXxwN6cGJggMjSx` |

## Key Concepts

| Concept            | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| Escrow             | PDA-controlled token account holding funds until release/refund |
| Delegate           | Off-chain keypair authorized to sign deposits for an authority  |
| Ed25519 Signatures | Off-chain signatures verified on-chain via instructions sysvar  |
| Replay Protection  | Bitmap tracking used nonces within time windows                 |
