# Deployment Guide

Deploy Escrow and Fulfillment Proxy programs from local development to production.

## Local Development

### Quick Start

```bash
# Start local validator
solana-test-validator --reset --quiet &

# Create and configure wallet
solana-keygen new --outfile ~/.config/solana/localnet.json --no-passphrase
solana config set --url localhost --keypair ~/.config/solana/localnet.json
solana airdrop 2

# Build, deploy, and test
anchor test --provider.cluster localnet
```

### Using deploy-local Script

For local development with mock tokens:

```bash
ANCHOR_WALLET=~/.config/solana/localnet.json \
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
npx ts-node scripts/deploy-local.ts
```

This script:

- Builds and deploys programs to localnet
- Initializes escrow with `cluster_id = "localnet"` and verifies the signature-domain fields
- Creates USDC and USDT mock token mints
- Writes addresses to `deployment-addresses.json`

## Production Deployment

### Using deploy Script (Recommended)

The `scripts/deploy.ts` script handles complete production deployment:

1. Builds and deploys both programs
2. Initializes escrow protocol with RBAC configuration
3. Verifies RBAC roles and escrow signature-domain fields match expected configuration
4. Revokes upgrade authority (makes programs immutable)

```bash
# Using keypair file (recommended)
SOLANA_RPC_URL=<rpc-url> \
DEPLOYER_KEYPAIR=<path-to-keypair.json> \
DEFAULT_ADMIN=<pubkey> \
TOKEN_CONFIG_AUTHORITY=<pubkey> \
TREASURER=<pubkey> \
PAUSER=<pubkey> \
yarn deploy

# Using base58 private key
SOLANA_RPC_URL=<rpc-url> \
DEPLOYER_PRIVATE_KEY=<base58-private-key> \
DEFAULT_ADMIN=<pubkey> \
yarn deploy
```

#### Environment Variables

| Variable                      | Required | Description                                                              |
| ----------------------------- | -------- | ------------------------------------------------------------------------ |
| `SOLANA_RPC_URL`              | Yes      | RPC endpoint URL                                                         |
| `DEPLOYER_KEYPAIR`            | No       | Path to keypair JSON (defaults to `.anchor/deployer.json`)               |
| `DEPLOYER_PRIVATE_KEY`        | No       | Deployer private key (base58, alternative to file)                       |
| `DEFAULT_ADMIN`               | No       | Admin role pubkey (defaults to deployer)                                 |
| `TOKEN_CONFIG_AUTHORITY`      | No       | Token config role pubkey (defaults to deployer)                          |
| `TREASURER`                   | No       | Treasurer pubkey (defaults to deployer)                                  |
| `PAUSER`                      | No       | Pauser pubkey (defaults to deployer)                                     |
| `ESCROW_CLUSTER_ID`           | No       | UTF-8 label encoded into escrow `cluster_id` (defaults from RPC cluster) |
| `DEFAULT_ADMIN_DELAY_SECONDS` | No       | Admin transfer delay (defaults to 0)                                     |
| `SKIP_BUILD`                  | No       | Set to "true" to skip anchor build                                       |
| `REVOKE_UPGRADE_AUTHORITY`    | No       | Set to "true" to permanently revoke the upgrade authority (default keeps it) |

**Note:** Either `DEPLOYER_KEYPAIR` file or `DEPLOYER_PRIVATE_KEY` must be provided. If both are
set, `DEPLOYER_PRIVATE_KEY` takes precedence.

#### Output

The script writes `deployment-artifact.json` containing:

- Program IDs
- RBAC configuration
- Escrow signature-domain settings (`cluster_id` and `signature_domain_version`)
- Network and timestamp
- Upgrade authority status

### Manual Deployment

#### Prerequisites

| Requirement      | Description                           |
| ---------------- | ------------------------------------- |
| Funded wallet    | Deployer wallet with sufficient SOL   |
| Anchor.toml      | Configured for target cluster         |
| Program keypairs | Optional, for deterministic addresses |

#### Cluster Configuration

| Cluster | RPC URL                               | Funding                       |
| ------- | ------------------------------------- | ----------------------------- |
| Devnet  | `https://api.devnet.solana.com`       | `solana airdrop 2`            |
| Testnet | `https://api.testnet.solana.com`      | `solana airdrop 2`            |
| Mainnet | `https://api.mainnet-beta.solana.com` | Transfer from exchange/wallet |

```bash
solana config set --url <RPC_URL>
solana config set --keypair ~/.config/solana/id.json
```

#### Anchor.toml Configuration

```toml
[provider]
cluster = "devnet"
wallet = "~/.config/solana/id.json"

[programs.localnet]
escrow = "F9mjwmRfYWVUJPwSm3ygG7c9Pq2JF2eqpHC6MpVffV85"
fulfillment_proxy = "679cgQsBfvGLbeJutpRmJvEZtx5pWsXxwN6cGJggMjSx"

[programs.devnet]
escrow = "F9mjwmRfYWVUJPwSm3ygG7c9Pq2JF2eqpHC6MpVffV85"
fulfillment_proxy = "679cgQsBfvGLbeJutpRmJvEZtx5pWsXxwN6cGJggMjSx"
```

#### Build and Deploy

```bash
anchor build
anchor deploy --provider.cluster <devnet|testnet|mainnet>
```

**Note:** Manual deployment requires separate protocol initialization and upgrade authority
revocation. Escrow initialization now also requires a 32-byte `cluster_id`, and clients are
expected to fetch `cluster_id` plus `signature_domain_version` from `ProtocolConfig` when composing
off-chain escrow messages.

### Verify Deployment

```bash
solana program show <PROGRAM_ID>
```

Verify: program is deployed, upgrade authority is correct, data length matches expected.

### Upload IDL (Optional)

```bash
anchor idl upgrade <PROGRAM_ID> --filepath target/idl/<program_name>.json --provider.cluster <cluster>
```

## Program Upgrades

| Action             | Command                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Check authority    | `solana program show <PROGRAM_ID>`                                                          |
| Deploy upgrade     | `anchor upgrade target/deploy/<program>.so --program-id <PROGRAM_ID>`                       |
| Transfer authority | `solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <NEW_AUTHORITY>` |
| Make immutable     | `solana program set-upgrade-authority <PROGRAM_ID> --final`                                 |

**Warning:** Making a program immutable is irreversible.

To move the live v4 programs to a newer build without changing their IDs or accounts, follow
[Upgrading the live Solana programs in place](upgrade-in-place.md).

## Deployment / upgrade model (v3 account layouts)

The v3 escrow (the `quote_hash` binding on reserve/release/refund, plus the fulfillment-proxy settler
allowlist) changes on-chain **account layouts**, and those layout changes are **not
in-place-migratable**:

| Account                              | Old size | New size | Change                                                                       |
| ------------------------------------ | -------- | -------- | --------------------------------------------------------------------------- |
| `DepositInfo` (escrow)               | 217 B    | 249 B    | adds `quote_hash: [u8; 32]`                                                  |
| `ProtocolConfig` (fulfillment_proxy) | ~119 B   | 636 B    | adds `enforce_settler_allowlist` + `authorized_settlers` (pre-sized for 16) |

The programs ship **no `realloc` and no migration instruction** for these accounts, **by design**. An
in-place program upgrade would leave existing `DepositInfo` / `ProtocolConfig` accounts at their old
size, and the next instruction that deserializes them would fail — so v3 is **not** shipped as an
in-place upgrade.

Instead, v3 is deployed as a **fresh redeploy**:

1. **Drain** all in-flight settlements to a terminal state (release/refund every open deposit) on the
   existing program.
2. **Deploy** the new program (fresh state).
3. **Re-initialize** protocol state on fresh PDAs via `initialize_protocol`, then provision the
   settler allowlist and flip `enforce_settler_allowlist` on when ready.

Because deposits are drained first, there are no legacy 217-byte `DepositInfo` accounts to migrate,
and the new `ProtocolConfig` is created at its full 636-byte size at init.

The end-to-end drain + redeploy + re-init sequence is owned by atum-core's cutover runbook
(`CORE-2116-ESCROW-CUTOVER.md`). This note records the on-chain rationale — i.e. why no
`realloc`/migration instruction exists in these programs.

## Deployment Checklist

### Pre-Deployment

- [ ] Tests pass locally
- [ ] Code reviewed
- [ ] Program IDs confirmed
- [ ] Deployer wallet funded
- [ ] Backup of deployer keypair

### Post-Deployment

- [ ] Verify with `solana program show`
- [ ] Verify escrow `cluster_id` and `signature_domain_version` on `ProtocolConfig`
- [ ] Test basic operations on target cluster
- [ ] Update client configurations
- [ ] Document deployed program IDs

## Troubleshooting

| Error                                            | Solution                                         |
| ------------------------------------------------ | ------------------------------------------------ |
| `Account has insufficient funds`                 | Fund the deployer wallet with more SOL           |
| `Program file too large`                         | Optimize program or split into multiple programs |
| `Transaction was not confirmed in 30.00 seconds` | Retry deployment or use different RPC endpoint   |
| `Program's authority does not match`             | Use correct keypair for upgrades                 |

## References

- [Anchor CLI](https://www.anchor-lang.com/docs/references/cli)
- [Solana CLI](https://solana.com/docs/intro/installation)
- [Program Deployment](https://docs.solana.com/cli/deploy-a-program)
