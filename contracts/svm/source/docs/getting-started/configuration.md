# Configuration Guide

## Anchor.toml

The `Anchor.toml` file controls build and deployment settings.

```toml
[toolchain]
package_manager = "yarn"

[features]
resolution = true
skip-lint = false

[provider]
cluster = "testnet"                   # localnet/devnet/testnet/mainnet
wallet = "~/.config/solana/id.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
```

To run a specific test file, modify the pattern (e.g., `tests/**/06*.ts`).

## Program IDs

The same program IDs are used across all clusters (localnet, devnet, testnet):

| Program           | ID                                             |
| ----------------- | ---------------------------------------------- |
| Escrow            | `F9mjwmRfYWVUJPwSm3ygG7c9Pq2JF2eqpHC6MpVffV85` |
| Fulfillment Proxy | `679cgQsBfvGLbeJutpRmJvEZtx5pWsXxwN6cGJggMjSx` |

## Environment Variables

When running tests outside of `anchor test`:

| Variable              | Value                      |
| --------------------- | -------------------------- |
| `ANCHOR_PROVIDER_URL` | `http://localhost:8899`    |
| `ANCHOR_WALLET`       | `~/.config/solana/id.json` |

## Solana CLI

| Command                              | Description         |
| ------------------------------------ | ------------------- |
| `solana config get`                  | View current config |
| `solana config set --url localhost`  | Set to localnet     |
| `solana config set --url devnet`     | Set to devnet       |
| `solana config set --url testnet`    | Set to testnet      |
| `solana config set --keypair <path>` | Set wallet          |

## Wallet Setup

```bash
# Create wallet (no passphrase for testing)
solana-keygen new --outfile ~/.config/solana/id.json --no-passphrase

# Fund on localnet (requires running validator)
solana airdrop 2

# Fund on devnet/testnet
solana airdrop 2 --url devnet
```

## Constants

Replay protection constants in `programs/escrow/src/constants.rs`:

| Constant              | Value | Description                         |
| --------------------- | ----- | ----------------------------------- |
| `REPLAY_HORIZON_SECS` | 128   | Validity window of an authorization |
| `REPLAY_SLICE_SECS`   | 256   | Time slice for bitmap epoch/parity  |
| `REPLAY_SLOTS`        | 235   | Usable slots per bitmap             |

## Next Steps

- [Quickstart Guide](quickstart.md)
- [Development Setup](../development/setup.md)
- [Deployment Guide](../operations/deployment.md)
