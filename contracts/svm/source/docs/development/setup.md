# Development Setup

This guide covers setting up a local development environment for the Solana Escrow project.

## Prerequisites

| Tool       | Required Version | Installation                                                        |
| ---------- | ---------------- | ------------------------------------------------------------------- |
| Rust       | 1.87.0           | [rustup.rs](https://www.rust-lang.org/tools/install)                |
| Solana CLI | 2.2.19 (Agave)   | [Solana Docs](https://docs.solana.com/cli/install-solana-cli-tools) |
| Node.js    | 24.3.0           | [nodejs.org](https://nodejs.org/)                                   |
| Yarn       | 1.22.19          | [yarnpkg.com](https://classic.yarnpkg.com/)                         |
| Anchor     | 0.31.1           | [anchor-lang.com](https://www.anchor-lang.com/docs/installation)    |

## Initial Setup

### 1. Clone the Repository

```bash
git clone git@github.com:Atum-Labs/solana-escrow.git
cd solana-escrow
```

### 2. Install Dependencies

```bash
yarn install
```

### 3. Build Programs

```bash
anchor build
```

This compiles the programs and generates:

- `target/deploy/*.so` - Compiled programs
- `target/idl/*.json` - Interface Definition Language files
- `target/types/*.ts` - TypeScript type definitions

## Local Validator Setup

### Start a Local Validator

```bash
solana-test-validator --reset --quiet &
```

The `--reset` flag ensures a clean ledger. Use `--quiet` for less verbose output.

### Create a Local Wallet

```bash
solana-keygen new --outfile ~/.config/solana/localnet.json --no-passphrase
```

### Configure CLI

```bash
solana config set --url localhost
solana config set --keypair ~/.config/solana/localnet.json
```

### Fund the Wallet

```bash
solana airdrop 2
```

## Running Tests

### Full Test Suite

```bash
anchor test
```

This starts a local validator, deploys programs, and runs all tests.

### Skip Build (Faster Iteration)

```bash
anchor test --skip-build
```

### Run Specific Test File

Edit `Anchor.toml`:

```toml
[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/06*.ts"
```

Then run:

```bash
anchor test --skip-build
```

Remember to revert `Anchor.toml` after:

```toml
[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
```

### Run Without anchor test

Set environment variables:

```bash
export ANCHOR_PROVIDER_URL=http://localhost:8899
export ANCHOR_WALLET=~/.config/solana/id.json
```

Then run directly:

```bash
npx ts-mocha -p tsconfig.json -t 1000000 tests/06_fulfillment_proxy.ts
```

## Project Structure

```
solana-escrow/
├── programs/
│   ├── escrow/                    # Main escrow program
│   │   └── src/
│   │       ├── lib.rs             # Entry point
│   │       ├── state.rs           # Account structures
│   │       ├── constants.rs       # Constants
│   │       ├── errors.rs          # Error codes
│   │       ├── events.rs          # Events
│   │       ├── instructions/      # Instruction handlers
│   │       │   ├── mod.rs
│   │       │   ├── delegate.rs
│   │       │   └── escrow.rs
│   │       └── utils/             # Utilities
│   │           ├── mod.rs
│   │           ├── replay.rs
│   │           └── signatures.rs
│   └── fulfillment_proxy/         # Fulfillment proxy program
│       └── src/lib.rs
├── tests/                         # TypeScript tests
│   ├── helpers.ts
│   ├── 02_delegate_lifecycle.ts
│   ├── 03_deposit_lifecycle.ts
│   ├── 04_post_deposit_flows.ts
│   ├── 06_fulfillment_proxy.ts
│   ├── 07_edge_cases.ts
│   ├── 08_replay_protection.ts
│   └── 09_pda_interactions.ts
├── scripts/
│   └── deploy-local.ts            # Local deployment script
├── migrations/
│   └── deploy.ts                  # Anchor deploy script
├── Anchor.toml                    # Anchor configuration
├── Cargo.toml                     # Rust workspace config
├── package.json
└── tsconfig.json
```

## Build Commands

| Command             | Description                         |
| ------------------- | ----------------------------------- |
| `yarn build`        | Compile programs via `anchor build` |
| `yarn test`         | Run `anchor test`                   |
| `yarn lint`         | Prettier check                      |
| `yarn lint:fix`     | Prettier fix                        |
| `yarn format`       | Prettier fix (alias)                |
| `yarn deploy:local` | Deploy to local validator           |

## IDE Setup

### VS Code Extensions

- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
- [Anchor](https://marketplace.visualstudio.com/items?itemName=AnchorWallet.anchor)
- [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

### Settings

Add to `.vscode/settings.json`:

```json
{
  "editor.formatOnSave": true,
  "rust-analyzer.linkedProjects": ["./Cargo.toml"]
}
```

## Troubleshooting

### Build Failures

1. Ensure correct Rust version: `rustup default 1.87.0`
2. Update Anchor: `avm use 0.31.1`
3. Clean build: `anchor clean && anchor build`

### Test Failures

1. Ensure local validator is running
2. Check wallet has SOL: `solana balance`
3. Reset validator: `solana-test-validator --reset`

### Program ID Mismatch

If program IDs don't match `Anchor.toml`:

```bash
anchor keys list
# Update Anchor.toml with correct IDs
anchor build
```

## Related Documentation

- [Quickstart Guide](../getting-started/quickstart.md)
- [Configuration Guide](../getting-started/configuration.md)
- [Testing Guide](testing.md)
- [Contributing Guidelines](contributing.md)
