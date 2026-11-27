#!/bin/bash

# Custom healthcheck script that verifies both anvil and busybox httpd are ready
# This is used by Docker's HEALTHCHECK directive

set -e

# Function to check if anvil is ready using PERMIT2 contract
check_anvil_ready() {
    # Check if PERMIT2 contract exists and has code
    if ! cast code "${PERMIT2_ADDRESS}" --rpc-url http://localhost:8545 2>/dev/null | grep -v '^0x$' > /dev/null; then
        return 1
    fi
    
    return 0
}

# Function to check if busybox httpd is ready
check_httpd_ready() {
    # Check if deployment addresses are available via HTTP
    if ! curl -f http://localhost:80/deploymentAddresses/Escrow 2>/dev/null | grep -E '^0x[a-fA-F0-9]{40}$' > /dev/null; then
        return 1
    fi
    
    if ! curl -f http://localhost:80/deploymentAddresses/FulfillmentProxy 2>/dev/null | grep -E '^0x[a-fA-F0-9]{40}$' > /dev/null; then
        return 1
    fi
    
    return 0
}

# Function to check if deployed contracts have code
check_deployed_contracts() {
    # Get deployment addresses from HTTP interface
    local escrow_address=$(curl -f http://localhost:80/deploymentAddresses/Escrow 2>/dev/null)
    local fulfillment_proxy_address=$(curl -f http://localhost:80/deploymentAddresses/FulfillmentProxy 2>/dev/null)
    
    # Check if Escrow contract has code
    if ! cast code "${escrow_address}" --rpc-url http://localhost:8545 2>/dev/null | grep -v '^0x$' > /dev/null; then
        echo "Escrow contract at ${escrow_address} has no code"
        return 1
    fi
    
    # Check if FulfillmentProxy contract has code
    if ! cast code "${fulfillment_proxy_address}" --rpc-url http://localhost:8545 2>/dev/null | grep -v '^0x$' > /dev/null; then
        echo "FulfillmentProxy contract at ${fulfillment_proxy_address} has no code"
        return 1
    fi
    
    return 0
}

# Check anvil readiness
if ! check_anvil_ready; then
    echo "Anvil not ready - PERMIT2 contract not found"
    exit 1
fi

# Check httpd readiness  
if ! check_httpd_ready; then
    echo "HTTP server not ready - deployment addresses not available"
    exit 1
fi

# Check deployed contracts have code
if ! check_deployed_contracts; then
    echo "Deployed contracts not ready - contracts have no code"
    exit 1
fi

# Source the central accounts file
source "/contracts/evm/accounts.sh"

# Function to check if default accounts have tokens
check_token_balances() {
    # Get chain ID to determine which tokens to check
    local chain_id=$(cast chain-id --rpc-url http://localhost:8545 2>/dev/null)
    
    # Parse tokens.json to get addresses for the current chain
    if [ ! -f "/contracts/evm/tokens.json" ]; then
        echo "tokens.json not found"
        return 1
    fi
    
    # Get all token names for this chain
    local token_names=$(jq -r ".\"$chain_id\" | keys[]" /contracts/evm/tokens.json 2>/dev/null)
    
    if [ -z "$token_names" ]; then
        echo "Could not find token configuration for chain ID: $chain_id in tokens.json"
        return 1
    fi
    
    echo "Token balances for chain ID: $chain_id"
    echo "=========================================="
    
    # Check balances for all accounts and all tokens
    local has_tokens=false
    for account in "${ANVIL_ACCOUNTS[@]}"; do
        echo "Account $account:"
        local account_has_tokens=false
        
        while IFS= read -r token_name; do
            if [ -n "$token_name" ]; then
                local token_address=$(jq -r ".\"$chain_id\".\"$token_name\".address" /contracts/evm/tokens.json)
                local decimals=$(jq -r ".\"$chain_id\".\"$token_name\".decimals" /contracts/evm/tokens.json)
                local balance=$(cast call $token_address "balanceOf(address)(uint256)" $account --rpc-url http://localhost:8545 2>/dev/null || echo "0x0")
                
                # Clean up the balance value by removing any scientific notation or brackets
                local clean_balance=$(echo "$balance" | sed 's/\[.*\]//' | sed 's/[^0-9x]//g')
                # Convert hex to decimal for display
                local decimal_balance=$((clean_balance))
                local human_balance=$(echo "scale=6; $decimal_balance / (10^$decimals)" | bc -l)
                echo "  $token_name: $human_balance"
                
                # Check if this account has any tokens
                if [ "$decimal_balance" != "0" ]; then
                    account_has_tokens=true
                    has_tokens=true
                fi
            fi
        done <<< "$token_names"
        
        if [ "$account_has_tokens" = false ]; then
            echo "  (No tokens found)"
        fi
        echo ""
    done
    
    # Return success if at least one account has tokens
    if [ "$has_tokens" = true ]; then
        return 0
    else
        echo "ERROR: No accounts have any tokens!"
        return 1
    fi
}

# Check token balances
if ! check_token_balances; then
    echo "ERROR: Default accounts have no tokens!"
    echo ""
    echo "This usually happens when Docker uses a cached build from before token funding was added."
    echo ""
    echo "To fix this, rebuild the containers without cache:"
    echo "  docker compose build --no-cache arbitrum celo"
    echo "  docker compose up -d arbitrum celo"
    echo ""
    echo "This is a one-time fix. After rebuilding, tokens will be included in the saved state."
    exit 1
fi

echo "Health check passed - anvil, httpd, deployed contracts, and token balances are all ready"
exit 0 