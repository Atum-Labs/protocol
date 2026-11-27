#!/usr/bin/env bash

# Custom token seeding script that deploys and mints ERC20 tokens directly.
#
# The token deployer is TEST_ACCOUNT, an address with no committed private key.
# Anvil acts for it through anvil_impersonateAccount, which keeps the nonce-0 and
# nonce-1 CREATE addresses (TUSDC, TUSDT) deterministic without a key in the repo.
# Only that one address is impersonated; the Anvil default accounts are never
# impersonated, so their nonces stay untouched.

set -e

ANVIL_PORT=${BUILD_PORT:-8545}
RPC_URL="http://127.0.0.1:${ANVIL_PORT}"

# Source the central accounts file
source "$(dirname "$0")/accounts.sh"

# Use TEST_ACCOUNT as deployer for deterministic contract addresses (nonce 0).
# It is impersonated, not signed for: see send_as_deployer below.
DEPLOYER_ADDRESS="$TEST_ACCOUNT"

ESCROW_OWNER_PRIVATE_KEY="$PROTOCOL_DEPLOYER_PRIVATE_KEY"

# Permit2 address on Arbitrum
PERMIT2_ADDRESS=${PERMIT2_ADDRESS:-0x000000000022D473030F116dDEE9F6B43aC78BA3}

# anvil_dumpState does not reliably persist untouched forked accounts. Force the
# canonical Permit2 bytecode into local state so --state-only devnet runtimes can
# execute Escrow.deposit without a runtime --fork-url.
persist_permit2_bytecode() {
    echo "Persisting Permit2 bytecode into local anvil state..."

    local permit2_code
    if ! permit2_code=$(cast code "$PERMIT2_ADDRESS" --rpc-url "$RPC_URL" 2>&1); then
        echo "ERROR: failed to read Permit2 bytecode from $RPC_URL: $permit2_code" >&2
        return 1
    fi
    if [ -z "$permit2_code" ] || [ "$permit2_code" = "0x" ]; then
        echo "ERROR: Permit2 bytecode not found at $PERMIT2_ADDRESS on build-time fork" >&2
        return 1
    fi

    cast rpc --rpc-url "$RPC_URL" anvil_setCode "$PERMIT2_ADDRESS" "$permit2_code" >/dev/null

    local persisted_code
    if ! persisted_code=$(cast code "$PERMIT2_ADDRESS" --rpc-url "$RPC_URL" 2>&1); then
        echo "ERROR: failed to verify persisted Permit2 bytecode from $RPC_URL: $persisted_code" >&2
        return 1
    fi
    if [ -z "$persisted_code" ] || [ "$persisted_code" = "0x" ]; then
        echo "ERROR: Permit2 bytecode was not persisted into local anvil state" >&2
        return 1
    fi

    echo "SUCCESS: Permit2 bytecode persisted at $PERMIT2_ADDRESS"
}

# Send a transaction from the deployer without its private key. Anvil accepts
# eth_sendTransaction for an impersonated address, which is what --unlocked uses.
# Call sites still pass --rpc-url and the rest of the cast send arguments.
send_as_deployer() {
    cast send --unlocked --from "$DEPLOYER_ADDRESS" "$@"
}

impersonate_deployer() {
    echo "Impersonating deployer $DEPLOYER_ADDRESS (no private key in the repo)..."
    cast rpc --rpc-url "$RPC_URL" anvil_impersonateAccount "$DEPLOYER_ADDRESS" >/dev/null
}

stop_impersonating_deployer() {
    cast rpc --rpc-url "$RPC_URL" anvil_stopImpersonatingAccount "$DEPLOYER_ADDRESS" >/dev/null
    echo "Stopped impersonating deployer $DEPLOYER_ADDRESS"
}

# Function to deploy a custom ERC20 token using cast send directly
deploy_custom_token() {
    local token_name=$1
    local token_symbol=$2
    local decimals=$3
    
    echo "Deploying custom token: $token_name ($token_symbol) with $decimals decimals..." >&2
    
    # Compile the contract first
    forge build --contracts test/mock/TestToken.sol >/dev/null 2>&1
    
    # Get the bytecode and constructor parameters
    local bytecode=$(forge inspect TestToken bytecode --contracts test/mock/TestToken.sol 2>/dev/null | tr -d '"')
    local constructor_params=$(cast abi-encode "constructor(string,string,uint8)" "$token_name" "$token_symbol" $decimals)
    local full_bytecode="${bytecode}${constructor_params:2}"  # Remove 0x from constructor params
    
    # Deploy using cast send with JSON output
    local deploy_result=$(send_as_deployer \
        --rpc-url "$RPC_URL" \
        --create "$full_bytecode" \
        --json \
        2>/dev/null)
    
    if [ -z "$deploy_result" ]; then
        echo "ERROR: Failed to deploy $token_name token" >&2
        return 1
    fi
    
    # Extract transaction hash from JSON
    local tx_hash=$(echo "$deploy_result" | jq -r '.transactionHash')
    
    if [ -z "$tx_hash" ] || [ "$tx_hash" = "null" ]; then
        echo "ERROR: Failed to get transaction hash for $token_name token" >&2
        return 1
    fi
    
    # Get the contract address from the transaction receipt
    local contract_address=$(cast receipt $tx_hash --rpc-url $RPC_URL --json 2>/dev/null | jq -r '.contractAddress')
    
    if [ -z "$contract_address" ]; then
        echo "ERROR: Failed to get contract address for $token_name token" >&2
        return 1
    fi

    # Tell the escrow contract to allow this token AND set its fee config in
    # one atomic call. The fee parameters mirror what testnet's V3 escrow has
    # for USDC (feePercentage 20000 in 1e8 = 0.02% / 2 bps, maxFee 250000000 in
    # 1e6 = $250 cap -- this MUST equal the fee cap veri-fill signs release and
    # refund witnesses with). This previously seeded $25 while claiming to match
    # veri-fill; it did not, and the mismatch is invisible below ~125,000 tokens
    # because neither cap binds there. Without this fee config, devnet's tokenConfig stays at zero fees
    # while veri-fill signs witnesses with the testnet 2-bps formula, and every
    # release/refund reverts with InvalidWitnessValues. Use the same account
    # that deployed the Escrow contract (has TOKEN_CONFIG_ROLE).
    if ! cast send $(cat /var/www/deploymentAddresses/Escrow) \
        "allowTokenAndSetFeeConfig(address,uint8,uint88,uint80,uint80)" \
        "$contract_address" "$decimals" 20000 0 250000000 \
        --private-key $ESCROW_OWNER_PRIVATE_KEY \
        --rpc-url $RPC_URL >/dev/null 2>&1; then
        echo "ERROR: Failed to allow token + set fee config" >&2
        return 1
    fi

    # verify the token was actually allowed (V3: returns address[])
    echo "Verifying token allowlist..." >&2
    local allowed_tokens=$(cast call $(cat /var/www/deploymentAddresses/Escrow) \
        "getAllowedTokens()(address[])" \
        --rpc-url $RPC_URL 2>/dev/null)
    if echo "$allowed_tokens" | grep -qi "$contract_address"; then
        echo "SUCCESS: Token $contract_address confirmed in allowlist" >&2
    else
        echo "ERROR: Token $contract_address NOT found in allowlist" >&2
        echo "Current allowed tokens: $allowed_tokens" >&2
        return 1
    fi
    
    echo "SUCCESS: $token_name deployed at $contract_address" >&2
    echo "$contract_address"
}

# Function to mint tokens to an account
mint_tokens_to_account() {
    local token_address=$1
    local recipient=$2
    local amount=$3
    local token_name=$4
    
    echo "Minting $amount $token_name to $recipient..."
    
    # Call mint function on the token contract
    local mint_result=$(send_as_deployer "$token_address" \
        "mint(address,uint256)" \
        "$recipient" "$amount" \
        --rpc-url "$RPC_URL" \
        2>&1)
    
    if [ $? -eq 0 ]; then
        echo "SUCCESS: Minted $amount $token_name to $recipient"
        # Wait a moment for the transaction to be mined
        sleep 0.5
    else
        echo "ERROR: Failed to mint $token_name to $recipient"
        echo "Error details: $mint_result"
        return 1
    fi
}

# Function to check token balance
check_token_balance() {
    local token_address=$1
    local account=$2
    local decimals=$3
    
    local balance=$(cast call $token_address "balanceOf(address)(uint256)" $account --rpc-url $RPC_URL 2>/dev/null || echo "0")
    local clean_balance=$(echo "$balance" | sed 's/\[.*\]//' | sed 's/[^0-9x]//g')
    local decimal_balance=$((clean_balance))
    local human_balance=$(echo "scale=6; $decimal_balance / (10^$decimals)" | bc -l)
    echo $human_balance
}

# Function to fund account with ETH
fund_account_with_eth() {
    local account=$1
    local amount_wei=$2
    
    echo "Funding $account with ETH..."
    
    # Use anvil_setBalance to give account ETH directly (no impersonation needed)
    cast rpc --rpc-url $RPC_URL anvil_setBalance $account $amount_wei >/dev/null
    
    local balance=$(cast balance $account --rpc-url $RPC_URL)
    local eth_balance=$(cast --to-unit $balance ether)
    echo "SUCCESS: Account $account now has $eth_balance ETH"
}

# Function to setup test environment with custom tokens
setup_custom_token_environment() {
    echo "=== SETTING UP CUSTOM TOKEN ENVIRONMENT ==="
    
    # Wait for Anvil to be ready
    echo "Waiting for Anvil to be ready..."
    while ! cast chain-id --rpc-url $RPC_URL >/dev/null 2>&1; do
        sleep 0.25
    done
    
    local chain_id=$(cast chain-id --rpc-url $RPC_URL)
    echo "Connected to chain ID: $chain_id"

    persist_permit2_bytecode
    
    # Fund the deployer with ETH for gas
    echo "Funding deployer with ETH..."
    fund_account_with_eth $DEPLOYER_ADDRESS "0x56BC75E2D63100000" # 100 ETH
    
    # Using TEST_ACCOUNT as deployer (clean nonce 0) for deterministic addresses
    echo "Using TEST_ACCOUNT as deployer for deterministic contract addresses"
    local current_nonce=$(cast nonce $DEPLOYER_ADDRESS --rpc-url $RPC_URL)
    echo "Deployer nonce: $current_nonce (should be 0 for deterministic addresses)"
    if [ "$current_nonce" != "0" ]; then
        echo "Resetting deployer nonce to 0 for deterministic contract addresses..."
        cast rpc --rpc-url $RPC_URL anvil_setNonce $DEPLOYER_ADDRESS "0x0" >/dev/null
        echo "Deployer nonce reset to 0"
    fi

    impersonate_deployer
    
    # Deploy custom tokens (these will deploy to the same addresses with nonce 0)
    echo "Deploying custom test tokens..."
    
    # Deploy USDC-like token (6 decimals)
    local usdc_address=$(deploy_custom_token "Test USDC" "TUSDC" 6)
    if [ -z "$usdc_address" ]; then
        echo "ERROR: Failed to deploy TUSDC"
        exit 1
    fi
    
    # Deploy USDT-like token (6 decimals) 
    local usdt_address=$(deploy_custom_token "Test USDT" "TUSDT" 6)
    if [ -z "$usdt_address" ]; then
        echo "ERROR: Failed to deploy TUSDT"
        exit 1
    fi
    
    # Fund test account with ETH first
    echo "=== FUNDING TEST ACCOUNT ==="
    fund_account_with_eth $TEST_ACCOUNT "0x56BC75E2D63100000" # 100 ETH
    
    # Mint generous amounts to test account
    local test_amount_usdc=$((1000000 * 10**6))  # 1M USDC
    local test_amount_usdt=$((2000000 * 10**6))  # 2M USDT
    
    mint_tokens_to_account $usdc_address $TEST_ACCOUNT $test_amount_usdc "TUSDC"
    mint_tokens_to_account $usdt_address $TEST_ACCOUNT $test_amount_usdt "TUSDT"
    
    # Fund additional clean test accounts
    echo "=== FUNDING ADDITIONAL CLEAN TEST ACCOUNTS ==="
    
    # TEST_ACCOUNT_2: Medium amounts for testing
    echo "Funding TEST_ACCOUNT_2: $TEST_ACCOUNT_2"
    fund_account_with_eth $TEST_ACCOUNT_2 "0x56BC75E2D63100000" # 100 ETH
    mint_tokens_to_account $usdc_address $TEST_ACCOUNT_2 $((500000 * 10**6)) "TUSDC"  # 500K TUSDC
    mint_tokens_to_account $usdt_address $TEST_ACCOUNT_2 $((750000 * 10**6)) "TUSDT"  # 750K TUSDT
    echo "  Balances: 500K TUSDC, 750K TUSDT"
    
    # TEST_ACCOUNT_3: Small amounts for testing edge cases
    echo "Funding TEST_ACCOUNT_3: $TEST_ACCOUNT_3"
    fund_account_with_eth $TEST_ACCOUNT_3 "0x56BC75E2D63100000" # 100 ETH
    mint_tokens_to_account $usdc_address $TEST_ACCOUNT_3 $((10000 * 10**6)) "TUSDC"   # 10K TUSDC
    mint_tokens_to_account $usdt_address $TEST_ACCOUNT_3 $((25000 * 10**6)) "TUSDT"   # 25K TUSDT
    echo "  Balances: 10K TUSDC, 25K TUSDT"
    
    # Fund other anvil accounts with smaller amounts
    echo "=== FUNDING ANVIL ACCOUNTS ==="
    local account_amount_usdc=$((100000 * 10**6))  # 100K USDC each
    local account_amount_usdt=$((200000 * 10**6))  # 200K USDT each
    
    for account in "${ANVIL_ACCOUNTS[@]}"; do
        if [ "$account" != "$TEST_ACCOUNT" ]; then
            echo "Funding account: $account"
            
            # Fund with ETH
            fund_account_with_eth $account "0x56BC75E2D63100000" # 100 ETH
            
            # Mint tokens
            mint_tokens_to_account $usdc_address $account $account_amount_usdc "TUSDC"
            mint_tokens_to_account $usdt_address $account $account_amount_usdt "TUSDT"
        fi
    done
    
    # Setup Permit2 approvals for all accounts
    echo "=== SETTING UP PERMIT2 APPROVALS ==="
    if [ -n "$PERMIT2_ADDRESS" ]; then
        # First approve for all clean test accounts
        for account in "${CLEAN_TEST_ACCOUNTS[@]}"; do
            echo "Setting up Permit2 approvals for CLEAN account $account..."
            
            # Use approveFor function to approve PERMIT2 on behalf of each account
            # Approve PERMIT2 to spend TUSDC
            send_as_deployer "$usdc_address" \
                "approveFor(address,address,uint256)" \
                "$account" \
                "$PERMIT2_ADDRESS" \
                "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" \
                --rpc-url "$RPC_URL" \
                2>/dev/null && \
            echo "SUCCESS: Approved PERMIT2 for TUSDC for $account"
            
            # Approve PERMIT2 to spend TUSDT  
            send_as_deployer "$usdt_address" \
                "approveFor(address,address,uint256)" \
                "$account" \
                "$PERMIT2_ADDRESS" \
                "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" \
                --rpc-url "$RPC_URL" \
                2>/dev/null && \
            echo "SUCCESS: Approved PERMIT2 for TUSDT for $account"
        done
        
        # Then approve for anvil accounts
        for account in "${ANVIL_ACCOUNTS[@]}"; do
            echo "Setting up Permit2 approvals for $account..."
            
            # Use approveFor function to approve PERMIT2 on behalf of each account
            # Approve PERMIT2 to spend TUSDC
            send_as_deployer "$usdc_address" \
                "approveFor(address,address,uint256)" \
                "$account" \
                "$PERMIT2_ADDRESS" \
                "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" \
                --rpc-url "$RPC_URL" \
                2>/dev/null && \
            echo "SUCCESS: Approved PERMIT2 for TUSDC for $account"
            
            # Approve PERMIT2 to spend TUSDT  
            send_as_deployer "$usdt_address" \
                "approveFor(address,address,uint256)" \
                "$account" \
                "$PERMIT2_ADDRESS" \
                "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" \
                --rpc-url "$RPC_URL" \
                2>/dev/null && \
            echo "SUCCESS: Approved PERMIT2 for TUSDT for $account"
        done
    else
        echo "WARNING: PERMIT2_ADDRESS not set, skipping approvals"
    fi

    # Impersonation is a node-side toggle, not chain state; drop it before the
    # state is dumped so nothing can send from the deployer afterwards.
    stop_impersonating_deployer
    
    
    # Save contract addresses for later use
    mkdir -p /var/www/tokenAddresses
    echo "$usdc_address" > /var/www/tokenAddresses/TUSDC
    echo "$usdt_address" > /var/www/tokenAddresses/TUSDT
    
    echo "=== TOKEN ENVIRONMENT SETUP COMPLETE ==="
    echo "TUSDC deployed at: $usdc_address"
    echo "TUSDT deployed at: $usdt_address"
    
    # Display final balances
    echo ""
    echo "=== FINAL BALANCES ==="
    echo "Test Account ($TEST_ACCOUNT):"
    local usdc_balance=$(check_token_balance $usdc_address $TEST_ACCOUNT 6)
    local usdt_balance=$(check_token_balance $usdt_address $TEST_ACCOUNT 6)
    echo "  TUSDC: $usdc_balance"
    echo "  TUSDT: $usdt_balance"
    echo ""
    
    # Show first few other accounts
    local count=0
    for account in "${ANVIL_ACCOUNTS[@]}"; do
        if [ "$account" != "$TEST_ACCOUNT" ] && [ $count -lt 3 ]; then
            echo "Account $account:"
            local usdc_balance=$(check_token_balance $usdc_address $account 6)
            local usdt_balance=$(check_token_balance $usdt_address $account 6)
            echo "  TUSDC: $usdc_balance"
            echo "  TUSDT: $usdt_balance"
            echo ""
            count=$((count + 1))
        fi
    done
    
    echo "Custom token environment ready!"
}

# Main execution
echo "Starting custom token seeding..."
setup_custom_token_environment
echo "Custom token seeding completed successfully!" 
