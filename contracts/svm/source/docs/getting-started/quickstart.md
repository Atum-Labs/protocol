# Quickstart

Get running locally in under 5 minutes.

## Prerequisites

| Tool       | Version     | Install                                                                 |
| ---------- | ----------- | ----------------------------------------------------------------------- |
| Rust       | stable      | [rustup.rs](https://rustup.rs/)                                         |
| Solana CLI | 2.x (Agave) | [solana.com/docs](https://docs.solana.com/cli/install-solana-cli-tools) |
| Node.js    | 20+ LTS     | [nodejs.org](https://nodejs.org/)                                       |
| Yarn       | 1.x         | `npm install -g yarn`                                                   |
| Anchor     | 0.32.x      | [anchor-lang.com](https://www.anchor-lang.com/docs/installation)        |

## Setup

```bash
git clone git@github.com:Atum-Labs/solana-escrow.git
cd solana-escrow
yarn install
anchor build
anchor test
```

All tests passing confirms a successful setup.

## Next Steps

- [Configuration Guide](configuration.md)
- [Architecture Overview](../architecture/overview.md)
- [Local Development Setup](../development/setup.md)
