#!/bin/bash -x

# Script to deploy contracts and save deployment addresses
# This script should be run in the contracts directory

set -e

source "$(dirname "$0")/accounts.sh"

echo "Deploying contracts..."

# Use default private key if not provided (for build-time deployment)
PRIVATE_KEY=${PROTOCOL_DEPLOYER_PRIVATE_KEY}

# V3 deployment requires PERMIT2_ADDRESS and SALT env vars
export PERMIT2_ADDRESS=${PERMIT2_ADDRESS:-0x000000000022D473030F116dDEE9F6B43aC78BA3}
export SALT=${SALT:-0x0000000000000000000000000000000000000000000000000000000000000000}

# Deploy core contracts and capture output
ANVIL_PORT=${BUILD_PORT:-8545}
DEPLOY_OUTPUT=$(forge script script/deploy/DeployCoreContracts.s.sol --rpc-url="localhost:${ANVIL_PORT}" --broadcast --private-key ${PRIVATE_KEY} --legacy 2>&1)

# Extract deployment addresses from output
ESCROW_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "Escrow contract deployed at:" | sed 's/.*Escrow contract deployed at: //')
FULFILLMENT_PROXY_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "FulfillmentProxy contract deployed at:" | sed 's/.*FulfillmentProxy contract deployed at: //')

# Create directory for deployment addresses
mkdir -p /var/www/deploymentAddresses

# Write addresses to text files
echo "$ESCROW_ADDRESS" > /var/www/deploymentAddresses/Escrow
echo "$FULFILLMENT_PROXY_ADDRESS" > /var/www/deploymentAddresses/FulfillmentProxy

# V3: Grant TOKEN_CONFIG_ROLE to the deployer so they can call allowToken later.
# TOKEN_CONFIG_ROLE = keccak256("TOKEN_CONFIG_ROLE")
TOKEN_CONFIG_ROLE=$(cast keccak "TOKEN_CONFIG_ROLE")
DEPLOYER_ADDRESS=$(cast wallet address --private-key ${PRIVATE_KEY})

echo "Granting TOKEN_CONFIG_ROLE to deployer $DEPLOYER_ADDRESS..."
cast send "$ESCROW_ADDRESS" \
    "grantRole(bytes32,address)" \
    "$TOKEN_CONFIG_ROLE" \
    "$DEPLOYER_ADDRESS" \
    --private-key ${PRIVATE_KEY} \
    --rpc-url "http://localhost:${ANVIL_PORT}" >/dev/null 2>&1

echo "Deployment complete!"
echo "Escrow: $ESCROW_ADDRESS"
echo "FulfillmentProxy: $FULFILLMENT_PROXY_ADDRESS"
