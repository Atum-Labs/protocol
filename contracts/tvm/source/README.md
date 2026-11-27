# TVM Contracts

Smart contracts for TRON Virtual Machine (TVM) with both Tronbox and Foundry test suites.

# Auditor explanation

These contracts are clones of the [EVM contracts](https://github.com/Atum-Labs/evm-contracts), with some small differences to support Tron:
- Solidity pragma version (0.8.23 instead of 0.8.27) due to tron-solc support
- `require` statements with custom errors changed to `if (...) revert CustomError()` because of the first point
- [TIP712](https://github.com/tronprotocol/tips/blob/master/tip-712.md) support (Tron's version of EIP712)
- Uses [permit2-tron](https://github.com/alexroan/permit2-tron), a permit2 fork, which uses TIP712 instead of EIP712
- USDT handling within the Atum contract is different. There is a bug in USDT contract on Tron mainnet, where `false` is always returned from `transfer`, even if successful. `transferFrom` does not have this problem. The Atum contract is constructed with the USDT address parameter, which is stored as an immutable variable. All transfer operations on this token use `transfer` instead of OZ's `safeTransfer`, which checks the return value.

The full set of diffs compared to the evm-contracts can be found:
- [evm-source.diff](./evm-source.diff)
- [evm-tests.diff](./evm-tests.diff)

## Prerequisites

- Node.js v20 (use `nvm use 20` or check `.nvmrc`)
- pnpm v10.12.1
- Docker (for local TRON node)
- Foundry (for Foundry tests)

## Setup

Copy the .env.example file into .env and fill in the vars.

```bash
# Install dependencies
make install-tronbox
make install-foundry
```

## Testing

### Tronbox Tests (TVM)

Run the full test suite with local TRON node:
```bash
make test-tronbox
```

This command will:
1. Start a local TRON node
2. Deploy contracts
3. Run tests
4. Stop the node

For individual steps:
```bash
make tron-node-up      # Start local TRON node
make migrate-tronbox   # Deploy contracts
pnpm test              # Run tests
make tron-node-down    # Stop node
```

### Foundry Tests

```bash
make test-foundry
```

Or manually:
```bash
forge test -vvv
```

## Key Commands

| Command | Description |
|---------|-------------|
| `make test-tronbox` | Run full TVM test suite |
| `make test-foundry` | Run Foundry test suite |
| `make tron-node-up` | Start local TRON node |
| `make tron-node-down` | Stop local TRON node |
| `make build-tronbox` | Compile contracts with Tronbox |
| `make build-foundry` | Compile contracts with Foundry |
| `make verify-manual-escrow` | Manually verify Escrow bytecode (requires NETWORK and ADDRESS) |
| `make verify-manual-proxy` | Manually verify FulfillmentProxy bytecode (requires NETWORK and ADDRESS) |
| `pnpm run migrate:development` | Deploy to local node |
| `pnpm run deploy:local` | Deploy to local node and write `deployment-addresses.json` (see below) |
| `pnpm run test:scripts` | Unit tests for the `deploy:local` helpers |
| `pnpm run console` | Open Tronbox console |

## Local deployment

`pnpm run deploy:local` deploys to the local node (`tronbox-config.js`, network `development`) and
writes `deployment-addresses.json`, the file the settler's e2e preflight and Tron harness read.

The node is `http://127.0.0.1:9090` unless `TRON_LOCAL_RPC_URL` names another one, for example
`TRON_LOCAL_RPC_URL=http://127.0.0.1:19090 pnpm run deploy:local`. It moves the whole
`development` network, so the migration the script runs deploys to the same node. Mainnet reads
`TRON_RPC_URL`, a separate variable, so setting one never redirects the other.

`tvm-contracts` is not a member of the repo's pnpm workspace (it has its own lockfile), so run it
from this directory, or from the repo root with
`pnpm --dir contracts/tvm/source --ignore-workspace run deploy:local` (what the settler runs).
`pnpm --filter tvm-contracts deploy:local` matches no project and exits 0 without doing anything.

The artifact:

```json
{
  "escrow": "T...",
  "fulfillmentProxy": "T...",
  "permit2": "T...",
  "usdc": "T...",
  "usdt": "T...",
  "tronChainId": "0xc845df2f"
}
```

Addresses are base58. `usdc` and `usdt` are 6-decimal `TestToken` doubles (anyone can `mint`),
both allowed on the Escrow at 6 decimals with the EVM `deploy:local` fee config (0.02%, min 1,
uncapped); `usdt` is the token the Escrow was constructed with.

The script:

1. Reads `tronChainId` from the node, not from config: the last 4 bytes of block 0's `blockID`
   (`wallet/getblockbynum {num: 0}`), cross-checked with `eth_chainId` on `/jsonrpc` and with what
   the `CHAINID` opcode returns (a constant call, nothing deployed). It fails before deploying if
   `CHAINID` is wider than the 4 bytes TIP-712 masks to, which the Escrow constructor would revert
   on.
2. Runs the development migration with `--reset`, and fails unless every contract got a fresh
   address. The migration also deploys the 18-decimal `MockERC20` the tronbox suites use.
3. Fails unless the Escrow was constructed with the migrated Permit2 and USDT doubles
   (`i_permit2()`, `i_usdt()`).
4. Fails unless the Escrow's and the Permit2 double's `DOMAIN_SEPARATOR()` equal the separators
   rebuilt off-chain for that chain id. The two domains differ: Escrow's is
   `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` with
   `"Escrow"`, `"3"`; permit2-tron's has no version, `"Permit2"` only. Step 1 has already matched
   `CHAINID` with the chain id, so a mismatch means the domain rebuilt in
   `scripts/deploy-local/domain-separator.js` has drifted from the contract's (for example a
   version bump in `Escrow.sol`), and no signature built from it would verify on-chain.
5. Deploys the USDC double, waits for its code, requires it to report 6 decimals, and allows both
   tokens.
6. Writes the artifact.

On any failure it exits non-zero and leaves no `deployment-addresses.json` behind.

### Local node image

`docker-compose.yml` pins `tronbox/tre` by digest:

```
tronbox/tre@sha256:f4332e11df12a9f360639a4546fd046593909630fda48af00b30410c144342f0
```

That digest's genesis gives chain id `0xc845df2f`. The settler's Tron e2e must run the same digest,
since its localnet `tronChainId` defaults to that id; bump both together. To move to a new image:

1. Resolve its index digest with `docker buildx imagetools inspect tronbox/tre:<tag>` and pin it in
   `docker-compose.yml`.
2. Run `deploy:local` against it. The script prints the chain id it read.
3. If the chain id changed, update it everywhere it is written down: the
   "Check deployment-addresses.json" step in `.github/workflows/ci.yml` (it fails until you do),
   this section and the artifact example above, the `docker-compose.yml` comment, and the
   settler's localnet `tronChainId` default.

## Manual Contract Verification

### Overview

This repository provides a manual verification script to confirm that deployed contracts match the source code. The script compiles contracts locally and compares the bytecode with on-chain deployments.

### Why Manual Verification?

These contracts use advanced Solidity compiler settings that Tronscan's web verification tool doesn't support:
- Via IR compilation (`viaIR: true`)
- Custom bytecode metadata (`bytecodeHash: 'none'`)
- Multiple solidity files in a directory structure

### Verifying Contracts

#### Using the Script Directly

```bash
node scripts/verify-contract.js <contract> <network> <address>
```

**Arguments:**
- `contract` - Contract name: `Escrow` or `FulfillmentProxy`
- `network` - Network name: `mainnet`, `shasta`, or `nile`
- `address` - Contract address (Tron base58 format)

**Examples:**

```bash
# Verify Escrow on mainnet
node scripts/verify-contract.js Escrow mainnet TYourEscrowMainnetAddress

# Verify FulfillmentProxy on shasta
node scripts/verify-contract.js FulfillmentProxy shasta TYourProxyAddress
```

#### Using Makefile Targets

```bash
# Manually verify Escrow
make verify-manual-escrow NETWORK=mainnet ADDRESS=TYourEscrowAddress

# Manually verify FulfillmentProxy
make verify-manual-proxy NETWORK=shasta ADDRESS=TYourProxyAddress
```

### What the Script Does

1. Cleans existing build artifacts
2. Compiles contracts using TronBox with production settings
3. Fetches on-chain bytecode from the specified network
4. Performs byte-by-byte comparison
   - For exact matches: Confirms bytecode is identical
   - For contracts with constructor arguments: Verifies compiled bytecode is a prefix of on-chain bytecode (on-chain includes ABI-encoded constructor arguments appended)

### Prerequisites

- Node.js v20 or higher
- pnpm installed
- Dependencies installed (`make install-tronbox`)
- Internet connection

### Verification Output

Success output shows:
- Contract name and address
- Network
- Compilation settings used
- Confirmation that bytecode matches

Failure output shows:
- Length differences
- First position where bytes differ
- Possible reasons for mismatch

## Project Structure

- `contracts/` - Smart contract source files
- `test/` - Tronbox test files
- `foundry_tests/` - Foundry test files
- `migrations/` - Tronbox deployment scripts

## Dependencies

- `@alexroan/permit2-tron` - Permit2 implementation for TRON
- `@openzeppelin/contracts` - OpenZeppelin contract library
- `solmate` - Gas-optimized contract library