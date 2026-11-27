# Escrow scripts (Tron)

Scripts for exercising and inspecting the Escrow contract on Tron networks. Every network script
reads its network settings, contract addresses and ABIs from `config.js`; `deploy-local.js` targets
only `tronbox-config.js`'s `development` network and reads `build/contracts/`.

## Setup

Set the signing key and, optionally, the RPC endpoint in the environment or a `.env` file:

```
DEPOSITOR_PK=<private key, hex without 0x>
TRON_RPC_URL=<optional, defaults to https://api.trongrid.io>
TRON_API_KEY=<optional TronGrid API key>
```

Install dependencies with `pnpm install`.

## Scripts

| Script | Usage | What it does |
|---|---|---|
| `deposit-and-release.js` | `node scripts/deposit-and-release.js <mainnet\|shasta> [amount]` | Runs a full deposit, reserve and release cycle, with `DEPOSITOR_PK` in every role. `amount` is in the token's native decimals (default `100000000`). |
| `query-escrow.js` | `node scripts/query-escrow.js <network> <escrow-address>` | Prints the Permit2 and token addresses an Escrow was deployed with. |
| `inspect-escrow.js` | `node scripts/inspect-escrow.js <network>` | Prints the Escrow's pause state, immutable configuration, allowed tokens and fee configuration, and role holders. |
| `verify-contract.js` | `node scripts/verify-contract.js <contract> <network> <address>` | Compiles the contract and checks the bytecode against what is deployed. |
| `run-tronbox-tests.sh` | `./scripts/run-tronbox-tests.sh` | Runs the TronBox suite and fails if it did not actually run. |
| `wait-for-tron.sh` | `./scripts/wait-for-tron.sh` | Waits for a local Tron node to accept requests. |
| `deploy-local.js` | `pnpm run deploy:local` | Deploys to the local tre node, checks the Escrow's and Permit2's `DOMAIN_SEPARATOR` against the node's chain id, and writes `deployment-addresses.json`. Its steps live in `deploy-local/run.js`; see `../README.md`, "Local deployment". |

## Admin scripts

`admin/` holds one script per administrative action, grouped by area:

- `access-control/`: begin, accept or cancel an admin transfer, change the admin delay, grant or revoke a role.
- `pause/`: pause or unpause the Escrow and the FulfillmentProxy.
- `token-config/`: allow or disallow a token and set or clear its fee configuration.
- `treasury/`: withdraw fee revenue.
