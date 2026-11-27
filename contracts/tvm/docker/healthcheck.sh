#!/bin/bash

# Health check script for Tron container
# Checks that:
# 1. Node is responding to API calls
# 2. Block data is available
# 3. Contracts are deployed (if expected)

# Check 0: Deployment failure marker
if [ -f /var/www/deploymentAddresses/.deployment_failed ]; then
    echo "Deployment failed during startup - check container logs"
    exit 1
fi

# Check 1: Basic API connectivity
if ! curl -s -f --max-time 2 "http://localhost:9090/wallet/getnowblock" > /dev/null 2>&1; then
    echo "Node API not responding"
    exit 1
fi

# Check 2: Verify block data
BLOCK_NUM=$(curl -s --max-time 2 http://localhost:9090/wallet/getnowblock 2>/dev/null | \
    python3 -c "import sys, json; data = json.load(sys.stdin); print(data.get('block_header', {}).get('raw_data', {}).get('number', 0))" 2>/dev/null)

if [ -z "$BLOCK_NUM" ] || [ "$BLOCK_NUM" = "0" ] || [ "$BLOCK_NUM" = "null" ]; then
    # Try with node instead of python3
    BLOCK_NUM=$(curl -s --max-time 2 http://localhost:9090/wallet/getnowblock 2>/dev/null | \
        node -e "try { const d = JSON.parse(require('fs').readFileSync(0, 'utf8')); console.log(d.block_header?.raw_data?.number || 0); } catch(e) { console.log(0); }" 2>/dev/null)
fi

if [ -z "$BLOCK_NUM" ] || [ "$BLOCK_NUM" = "0" ]; then
    echo "No valid block data"
    exit 1
fi

# Check 3: Verify admin accounts endpoint (used by tests)
if ! curl -s -f --max-time 2 "http://localhost:9090/admin/accounts?format=all" > /dev/null 2>&1; then
    echo "Admin accounts endpoint not responding"
    exit 1
fi

# Check 4: Verify HTTP server is running (check for a specific file since busybox doesn't serve directory listings)
if ! curl -s -f --max-time 2 "http://localhost/deploymentAddresses/FulfillmentProxy" > /dev/null 2>&1; then
    echo "Contract addresses HTTP server not responding"
    exit 1
fi

# Check 5: Verify FulfillmentProxy address file exists and has content
FULFILLMENT_PROXY=$(curl -s --max-time 2 "http://localhost/deploymentAddresses/FulfillmentProxy" 2>/dev/null)
if [ -z "$FULFILLMENT_PROXY" ] || [ "$FULFILLMENT_PROXY" = "null" ]; then
    echo "FulfillmentProxy address not yet available"
    exit 1
fi

# Check 6: Verify MockERC20 address file exists and has content
MOCK_ERC20=$(curl -s --max-time 2 "http://localhost/deploymentAddresses/MockERC20" 2>/dev/null)
if [ -z "$MOCK_ERC20" ] || [ "$MOCK_ERC20" = "null" ]; then
    echo "MockERC20 address not yet available"
    exit 1
fi

# Check 7: Verify Permit2 address file exists and has content
PERMIT2=$(curl -s --max-time 2 "http://localhost/deploymentAddresses/Permit2" 2>/dev/null)
if [ -z "$PERMIT2" ] || [ "$PERMIT2" = "null" ]; then
    echo "Permit2 address not yet available"
    exit 1
fi

# Check 8: Verify Escrow address file exists and has content
ESCROW=$(curl -s --max-time 2 "http://localhost/deploymentAddresses/Escrow" 2>/dev/null)
if [ -z "$ESCROW" ] || [ "$ESCROW" = "null" ]; then
    echo "Escrow address not yet available"
    exit 1
fi

# Enhanced Check: Verify contract code exists at addresses (not just address files)
# Use Tron RPC to check if contracts have code
echo "🔍 Verifying contract code exists at addresses..."

# Function to check if contract exists at address
check_contract() {
    local NAME=$1
    local ADDRESS=$2
    
    # Convert hex address to base58 if needed (Tron uses base58 for API calls)
    # The address from file is in hex format starting with 41
    
    # Query the contract using Tron RPC
    RESPONSE=$(curl -s --max-time 2 -X POST "http://localhost:9090/wallet/getcontract" \
        -H "Content-Type: application/json" \
        -d "{\"value\": \"$ADDRESS\"}" 2>/dev/null)
    
    # Check if response contains bytecode (indicates contract exists)
    if echo "$RESPONSE" | grep -q "bytecode"; then
        echo "  ✅ $NAME contract verified at $ADDRESS"
        return 0
    else
        echo "  ❌ $NAME contract NOT found at $ADDRESS"
        return 1
    fi
}

# Verify each contract
CONTRACTS_OK=true
check_contract "FulfillmentProxy" "$FULFILLMENT_PROXY" || CONTRACTS_OK=false
check_contract "MockERC20" "$MOCK_ERC20" || CONTRACTS_OK=false
check_contract "Permit2" "$PERMIT2" || CONTRACTS_OK=false
check_contract "Escrow" "$ESCROW" || CONTRACTS_OK=false

if [ "$CONTRACTS_OK" = false ]; then
    echo "Contract verification failed"
    exit 1
fi

# Check 9: Verify token balances for ALL test accounts
echo "💰 Verifying token balances for all test accounts..."

# Function to check token balance
check_token_balance() {
    local ACCOUNT_NAME=$1
    local ACCOUNT_HEX=$2  # Hex address without 41 prefix
    
    # Prepare the parameter (32 bytes, padded)
    local PARAM=$(printf "%064s" "$ACCOUNT_HEX" | tr ' ' '0')
    
    # Call balanceOf function on MockERC20
    RESPONSE=$(curl -s --max-time 2 -X POST "http://localhost:9090/wallet/triggerconstantcontract" \
        -H "Content-Type: application/json" \
        -d "{
            \"owner_address\": \"417e5f4552091a69125d5dfcb7b8c2659029395bdf\",
            \"contract_address\": \"$MOCK_ERC20\",
            \"function_selector\": \"balanceOf(address)\",
            \"parameter\": \"$PARAM\"
        }" 2>/dev/null)
    
    # Extract the constant_result (balance in hex)
    BALANCE_HEX=$(echo "$RESPONSE" | grep -o '"constant_result":\["[^"]*"' | sed 's/.*\["\([^"]*\)".*/\1/')
    
    # Expected balance is 0xe8d4a51000 (1000000000000 in decimal)
    if [ "$BALANCE_HEX" = "000000000000000000000000000000000000000000000000000000e8d4a51000" ]; then
        echo "  ✅ $ACCOUNT_NAME has correct balance (1,000,000 tokens)"
        return 0
    else
        echo "  ❌ $ACCOUNT_NAME balance incorrect or zero"
        return 1
    fi
}

# Dynamically get test account hex addresses from accounts-helper
TOTAL_ACCOUNTS=9
BALANCES_OK=0

# Get all test accounts as JSON
ACCOUNTS_JSON=$(cd /contracts/tvm && node -e "
const accountsHelper = require('./docker/accounts-helper');
const tronweb = require('tronweb');
const TronWeb = tronweb.TronWeb || tronweb;
const accounts = accountsHelper.getTestAccounts(new TronWeb({fullHost: 'http://127.0.0.1:9090'}));
const result = accounts.map((acc, i) => ({
    index: i,
    name: acc.name,
    hex: TronWeb.address.toHex(acc.address).substring(2)
}));
console.log(JSON.stringify(result));
" 2>/dev/null)

if [ -z "$ACCOUNTS_JSON" ]; then
    echo "❌ Failed to load test accounts dynamically"
    exit 1
fi

# Check balance for each account
for i in $(seq 0 8); do
    ACCOUNT_HEX=$(echo "$ACCOUNTS_JSON" | node -e "
        const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
        const account = data[${i}];
        if (account) console.log(account.hex);
    " 2>/dev/null)
    
    if [ -n "$ACCOUNT_HEX" ]; then
        echo "  Checking account $((i+1)): $ACCOUNT_HEX"
        check_token_balance "Test Account $((i+1))" "$ACCOUNT_HEX" && ((BALANCES_OK++))
    fi
done

if [ "$BALANCES_OK" -ne "$TOTAL_ACCOUNTS" ]; then
    echo "❌ Token balance verification failed ($BALANCES_OK/$TOTAL_ACCOUNTS accounts have correct balance)"
    exit 1
fi

# Check 10: Verify Permit2 approvals for all test accounts
echo "🔐 Verifying Permit2 approvals..."

# Function to check token allowance
check_permit2_allowance() {
    local ACCOUNT_NAME=$1
    local ACCOUNT_HEX=$2  # Hex address without 41 prefix
    
    # Get Permit2 hex address without 41 prefix
    local PERMIT2_HEX=$(echo "$PERMIT2" | sed 's/^41//')
    
    # Prepare parameters for allowance(owner, spender) - both addresses padded to 32 bytes
    local OWNER_PARAM=$(printf "%064s" "$ACCOUNT_HEX" | tr ' ' '0')
    local SPENDER_PARAM=$(printf "%064s" "$PERMIT2_HEX" | tr ' ' '0')
    local PARAM="${OWNER_PARAM}${SPENDER_PARAM}"
    
    # Call allowance function on MockERC20
    RESPONSE=$(curl -s --max-time 2 -X POST "http://localhost:9090/wallet/triggerconstantcontract" \
        -H "Content-Type: application/json" \
        -d "{
            \"owner_address\": \"417e5f4552091a69125d5dfcb7b8c2659029395bdf\",
            \"contract_address\": \"$MOCK_ERC20\",
            \"function_selector\": \"allowance(address,address)\",
            \"parameter\": \"$PARAM\"
        }" 2>/dev/null)
    
    # Extract the result
    ALLOWANCE_HEX=$(echo "$RESPONSE" | grep -o '"constant_result":\["[^"]*"' | sed 's/.*\["\([^"]*\)".*/\1/')
    
    # Check if allowance is max uint256 (64 f's)
    if [[ "$ALLOWANCE_HEX" == *"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" ]]; then
        echo "  ✅ $ACCOUNT_NAME has max Permit2 approval"
        return 0
    elif [ -z "$ALLOWANCE_HEX" ] || [ "$ALLOWANCE_HEX" = "0000000000000000000000000000000000000000000000000000000000000000" ]; then
        echo "  ❌ $ACCOUNT_NAME has no Permit2 approval"
        return 1
    else
        echo "  ⚠️  $ACCOUNT_NAME has partial Permit2 approval"
        return 1
    fi
}

# Check all 9 test accounts for Permit2 approvals dynamically
APPROVALS_OK=0

# Reuse the same ACCOUNTS_JSON from above (it's already loaded)
for i in $(seq 0 8); do
    ACCOUNT_HEX=$(echo "$ACCOUNTS_JSON" | node -e "
        const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
        const account = data[${i}];
        if (account) console.log(account.hex);
    " 2>/dev/null)
    
    if [ -n "$ACCOUNT_HEX" ]; then
        echo "  Checking Permit2 approval for account $((i+1)): $ACCOUNT_HEX"
        check_permit2_allowance "Test Account $((i+1))" "$ACCOUNT_HEX" && ((APPROVALS_OK++))
    fi
done

if [ "$APPROVALS_OK" -ne "$TOTAL_ACCOUNTS" ]; then
    echo "❌ Permit2 approval verification failed ($APPROVALS_OK/$TOTAL_ACCOUNTS accounts approved)"
    exit 1
fi

echo "✅ Health check passed - all contracts deployed, verified, tokens minted, and Permit2 approvals set"
echo "  FulfillmentProxy: $FULFILLMENT_PROXY"
echo "  MockERC20: $MOCK_ERC20"
echo "  Permit2: $PERMIT2"
echo "  Escrow: $ESCROW"
echo "  Token balances verified: $BALANCES_OK/$TOTAL_ACCOUNTS test accounts"
echo "  Permit2 approvals verified: $APPROVALS_OK/$TOTAL_ACCOUNTS test accounts"
exit 0