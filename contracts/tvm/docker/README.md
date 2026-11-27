# Tron Devnet Docker Container

## Overview

This directory contains the Docker setup for running a local Tron devnet with pre-deployed contracts, similar to our EVM (Anvil) containers for Arbitrum and Optimism. The container provides a fully functional Tron blockchain environment for local development and testing of cross-chain payment infrastructure.

## Features

- **Deterministic Test Accounts**: 10 pre-configured accounts with consistent addresses across container restarts
- **Pre-deployed Contracts**: All required smart contracts (Escrow, FulfillmentProxy, MockERC20, Permit2) deployed automatically
- **Token Distribution**: Each test account receives 1,000,000,000,000 MockERC20 tokens
- **Permit2 Approvals**: All test accounts have max approvals set for Permit2 contract
- **HTTP API**: Contract addresses served via HTTP endpoint for easy integration
- **Health Checking**: Built-in health check verifies all contracts and configurations

## Quick Start

### Build the container
```bash
ENV=dev ./dc.sh build tron
```

### Start the container
```bash
ENV=dev ./dc.sh up -d tron
```

### Check logs
```bash
./dc.sh logs tron --follow
```

### Verify deployment
```bash
# Check if node is responding
curl http://localhost:9096/wallet/getnowblock

# Get deployed contract addresses
curl http://localhost:8089/addresses.json
```

## Test Accounts

The container provides 10 deterministic test accounts:

| Account | Address | Private Key (simplified) | Initial Balance |
|---------|---------|-------------------------|-----------------|
| 0 (Deployer) | `TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC` | `0x0...01` | 98999909999 TRX |
| 1 | `TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ` | `0x1...11` | 10000 TRX + tokens |
| 2 | `TBvJUBXorwBPzqvV38vjDgegj5Eh6g2Tsq` | `0x2...22` | 10000 TRX + tokens |
| 3 | `TJRabPrwbZy45sbavfcjinPJC18kjpRTv8` | `0x3...33` | 10000 TRX + tokens |
| 4 | `TLfuw4tRywtxCusvTudbjf7PbcXjfe7qrw` | `0x4...44` | 10000 TRX + tokens |
| 5 | `TWa5cxQFesyCQUm17usvHrVkKce6rMCV4H` | `0x5...55` | 10000 TRX + tokens |
| 6 | `TVwvLcXD1WTK2gegh7tZ5Fxocfo8GttHgL` | `0x6...66` | 10000 TRX + tokens |
| 7 | `TRsbuxREXKJKonexpejWhacE4sYHt1BSHV` | `0x7...77` | 10000 TRX + tokens |
| 8 | `TJzXt1sZautjqXnpjQT4xSCBHNSYgBkDr3` | `0x8...88` | 10000 TRX + tokens |
| 9 | `TBCtDueBN3LeyrJA8bKWetb5s3JfePK19X` | `0x9...99` | 10000 TRX + tokens |

**Note**: Full private keys follow the pattern `0x1111...1111` (64 '1's), `0x2222...2222`, etc.

## Directory Structure

```
contracts/tvm/
├── docker/
│   ├── Dockerfile              # Container build configuration
│   ├── entrypoint.sh          # Runtime startup script
│   ├── healthcheck.sh         # Health check script
│   ├── accounts.json          # Deterministic test accounts
│   ├── accounts-helper.js     # Account management utilities
│   ├── set_permit2_approvals.js # Permit2 approval setup
│   └── README.md              # This file
├── migrations/                # Integration-specific migrations
│   ├── 6_save_addresses.js    # Save contract addresses to be hosted via HTTP
│   ├── 7_mint_tokens.js       # Mint tokens to test accounts
│   └── README.md              # Migration documentation
└── repo/                      # Git submodule with Tron contracts
```

## Deployed Contracts

The following contracts are automatically deployed on container startup:

- **FulfillmentProxy**: Payment fulfillment proxy contract
- **MockERC20**: Test TRC-20 token for development
- **Permit2**: Token approval management (similar to Uniswap Permit2)
- **Escrow**: Core payment escrow contract

Contract addresses are available via HTTP at `http://localhost:8089/addresses.json` once deployment completes.

## Network Configuration

### Ports

| External Port | Internal Port | Service |
|--------------|---------------|---------|
| 9096 | 9090 | HTTP/RPC API |
| 8089 | 80 | Contract addresses HTTP |
| 50061 | 50051 | gRPC |
| 50062 | 50052 | gRPC (SolidityNode) |

### Docker Compose

The container is integrated with the project's Docker Compose setup, in `docker-compose.dev.yml`.

## Development Workflow

### 1. Modifying contracts

To modify Tron contracts, edit files in `contracts/tvm/source/contracts/`. After making changes:

```bash
# Rebuild the container to compile contracts
ENV=dev ./dc.sh build tron

# Restart to deploy new contracts
ENV=dev ./dc.sh down tron
ENV=dev ./dc.sh up -d tron
```

### 2. Testing contract interactions

```javascript
// Example: Interacting with deployed contracts
const TronWeb = require('tronweb');

const tronWeb = new TronWeb({
    fullHost: 'http://localhost:9096',
    privateKey: '1111111111111111111111111111111111111111111111111111111111111111'
});

// Get contract addresses
const addresses = await fetch('http://localhost:8089/addresses.json').then(r => r.json());

// Interact with MockERC20
const token = await tronWeb.contract().at(addresses.MockERC20);
const balance = await token.balanceOf('TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ').call();
console.log('Balance:', balance.toString());
```

### 3. Running integration tests

```bash
# Run full integration test suite
make all
```

## Troubleshooting

### Container won't start
```bash
# Check container logs
./dc.sh logs tron

# Ensure ports are available
lsof -i :9096
lsof -i :8089
```

### Contracts not deploying
```bash
# Check migration status
./dc.sh exec tron ls -la /var/www/deploymentAddresses/

# Run migrations manually
./dc.sh exec tron bash -c "cd /contracts/tvm && tronbox migrate --reset --network development"
```

### Node not responding
```bash
# Check FullNode process
./dc.sh exec tron ps aux | grep FullNode

# View FullNode logs
./dc.sh exec tron cat /tron/FullNode/start.log
```

## Technical Details

### Base Image
- **Image**: `herryxcodes/blockchain-nodes-x86:latest`
- **Tron Version**: tron-quickstart v1.0.4
- **Node.js**: v16 (limited by CentOS 7 glibc)
- **TronBox**: v4.2.0

### Migration System
The container uses a two-tier migration system:
1. **Core migrations** (1-5): From the git submodule, deploy core contracts
2. **Integration migrations** (6-7): handle integration-specific setup

### Performance
- **Current startup time**: ~45-60 seconds
- **Contract compilation**: Done at build time
- **Contract deployment**: Done at runtime (for reliability)

## Integration with Payment Infrastructure

### Chain Configuration
For cross-chain payment testing:
- **Source chain**: Tron (local devnet)
- **Source asset**: `tron:0x2b6653dc/trc20:${MockERC20_ADDRESS}`
- **Destination chain**: Optimism or other supported chains
- **Settlement**: Via TRC-20 tokens and Permit2

### CAIP-2 Chain IDs
- **Tron Mainnet**: `tron:0x2b6653dc`
- **Local Devnet**: Custom ID configured in test environment. See `tronbox-config.js`.

## References

- [Tron Documentation](https://developers.tron.network/)
- [TronBox Documentation](https://developers.tron.network/docs/tronbox)
- [CAIP-2 Chain IDs](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md)
- [TRC-20 Standard](https://developers.tron.network/docs/trc20)