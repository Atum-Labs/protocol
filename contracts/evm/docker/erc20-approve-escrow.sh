#!/usr/bin/env bash

# ERC20 approval script for escrow contract
# This script grants unlimited approval for all tokens to the escrow contract for all test accounts

set -e

RPC_URL="http://127.0.0.1:8545"
TOKENS_CONFIG="./tokens.json"
ESCROW_ADDRESS_FILE="/var/www/deploymentAddresses/Escrow"

# Source the central accounts file
source "/contracts/evm/accounts.sh"

# Function to approve tokens for escrow
approve_token_for_account() {
    local token_address=$1
    local account=$2
    local token_name=$3
    local spender=$4

    echo "Approving unlimited $token_name for account $account to spender $spender..."

    # Impersonate the account
    if ! cast rpc --rpc-url $RPC_URL anvil_impersonateAccount $account >/dev/null 2>&1; then
        echo "Warning: Failed to impersonate account $account, skipping"
        return
    fi

    # Fund account with ETH for gas if needed
    cast rpc --rpc-url $RPC_URL anvil_setBalance $account 0x56BC75E2D63100000 >/dev/null # 100 ETH

    # Max uint256 value for unlimited approval
    local max_uint256="0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

    # Send approval transaction
    if cast send $token_address "approve(address,uint256)(bool)" $spender $max_uint256 \
         --from $account --rpc-url $RPC_URL --unlocked >/dev/null 2>&1; then
        echo "SUCCESS: Account $account approved unlimited $token_name for $spender"
    else
        echo "FAILED: Could not approve $token_name for account $account"
    fi

    # Verify the allowance was set correctly
    local allowance=$(cast call $token_address "allowance(address,address)(uint256)" $account spender --rpc-url $RPC_URL)
    if [ "$allowance" = "0" ] || [ "$allowance" = "0x0" ]; then
        echo "ERROR: Allowance verification failed - allowance is 0 for $token_name"
        exit 1
    fi

    # Stop impersonating the account
    cast rpc --rpc-url $RPC_URL anvil_stopImpersonatingAccount $account >/dev/null 2>&1
}

# Function to process tokens from config file
process_token_approvals() {
    local chain_id=$1
    local spender=$2

    echo "Spender is $spender"

    if ! command -v jq &> /dev/null; then
        echo "Error: jq is required but not installed"
        exit 1
    fi

    if [ ! -f "$TOKENS_CONFIG" ]; then
        echo "Error: tokens.json not found at $TOKENS_CONFIG"
        exit 1
    fi

    # Get token names for this chain
    local token_names=$(jq -r ".\"$chain_id\" | keys[]" "$TOKENS_CONFIG" 2>/dev/null)

    if [ -z "$token_names" ]; then
        echo "No tokens configured for chain $chain_id"
        return
    fi

    # Process each token
    while IFS= read -r token_name; do
        echo "Processing approvals for $token_name..."

        local token_address=$(jq -r ".\"$chain_id\".\"$token_name\".address" "$TOKENS_CONFIG")

        # Approve for each account
        for account in "${ANVIL_ACCOUNTS[@]}"; do
            approve_token_for_account "$token_address" "$account" "$token_name" "$spender"
        done

    done <<< "$token_names"
}

# Main execution
echo "Starting ERC20 approval setup for escrow contract..."

# Wait for Anvil to be fully ready
echo "Waiting for Anvil to be ready..."
while ! cast chain-id --rpc-url $RPC_URL >/dev/null 2>&1; do
    sleep 0.25
done

# Detect chain ID
CHAIN_ID=$(cast chain-id --rpc-url $RPC_URL)
echo "Detected Chain ID: $CHAIN_ID"

# Read escrow contract address
if [ ! -f "$ESCROW_ADDRESS_FILE" ]; then
    echo "Error: Escrow address file not found at $ESCROW_ADDRESS_FILE"
    echo "Make sure deploy-contracts.sh has been run first"
    exit 1
fi

ESCROW_ADDRESS=$(cat "$ESCROW_ADDRESS_FILE")
if [ -z "$ESCROW_ADDRESS" ]; then
    echo "Error: Escrow address is empty"
    exit 1
fi

echo "Escrow contract address: $ESCROW_ADDRESS"
echo "Spender: $PERMIT2_ADDRESS"
echo "Setting up unlimited ERC20 approvals for $spender contract on chain $CHAIN_ID..."

# Process token approvals
process_token_approvals "$CHAIN_ID" "$PERMIT2_ADDRESS"

echo "ERC20 approval setup completed successfully!"
echo "All accounts now have unlimited approval for all tokens to $spender"
