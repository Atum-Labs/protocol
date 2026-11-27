#!/usr/bin/env bash
# Query RoleGranted/RoleRevoked events and determine current role holders
# Role hashes are fetched dynamically from the contract (PAUSER_ROLE, TREASURER_ROLE, TOKEN_CONFIG_ROLE)
# Usage: ./script/inspection/get_role_state.sh [--trace] [--from-block <block>] <rpc_url> <contract_address>
# Requires: cast (foundry)

set -e

# Print usage
usage() {
    echo "Usage: $0 [--trace] [--from-block <block>] <rpc_url> <contract_address>"
    echo ""
    echo "Arguments:"
    echo "  --trace              Show event trace grouped by role"
    echo "  --from-block <block> Starting block for event queries (default: 0)"
    echo "                       Use this if the RPC has block range limits"
    echo "  <rpc_url>            RPC URL for the target chain"
    echo "  <contract_address>   Contract address to query"
    echo ""
    echo "Example:"
    echo "  $0 https://sepolia-rollup.arbitrum.io/rpc 0x31dB576e05b6Cc510f4382Be025A0e51f3f556b9"
    echo "  $0 --trace https://sepolia-rollup.arbitrum.io/rpc 0x31dB576e05b6Cc510f4382Be025A0e51f3f556b9"
    echo "  $0 --from-block 20000000 https://sepolia.base.org 0xBEc3fbF58e4115e373670C2A6F12f4bF0601E488"
    exit 1
}

# Parse arguments
TRACE=false
FROM_BLOCK="0"
RPC_URL=""
CONTRACT_ADDRESS=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --trace)
            TRACE=true
            shift
            ;;
        --from-block)
            FROM_BLOCK="$2"
            shift 2
            ;;
        --help|-h)
            usage
            ;;
        *)
            # First non-flag arg is RPC_URL, second is CONTRACT_ADDRESS
            if [ -z "$RPC_URL" ]; then
                RPC_URL="$1"
            elif [ -z "$CONTRACT_ADDRESS" ]; then
                CONTRACT_ADDRESS="$1"
            fi
            shift
            ;;
    esac
done

# Validate required arguments
if [ -z "$RPC_URL" ]; then
    echo "Error: RPC_URL is required"
    echo ""
    usage
fi

if [ -z "$CONTRACT_ADDRESS" ]; then
    echo "Error: CONTRACT_ADDRESS is required"
    echo ""
    usage
fi

# Event signatures
ROLE_GRANTED_SIG="0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d"
ROLE_REVOKED_SIG="0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b"

# Function to find the deployment block via binary search
# Uses eth_getCode to find when contract code first appeared
# Returns 0 if detection fails (e.g., RPC doesn't support historical state)
find_deployment_block() {
    local latest=$(cast block-number --rpc-url "$RPC_URL" 2>/dev/null)
    if [ -z "$latest" ]; then
        echo "0"
        return
    fi
    
    local low=0
    local high=$latest
    local mid
    local code
    local error_count=0
    
    while [ $low -lt $high ]; do
        mid=$(( (low + high) / 2 ))
        # Capture both stdout and stderr to detect RPC errors
        local result=$(cast code "$CONTRACT_ADDRESS" --block $mid --rpc-url "$RPC_URL" 2>&1)
        
        # Check for RPC errors (missing trie node, etc.)
        if echo "$result" | grep -qi "error\|missing trie node"; then
            error_count=$((error_count + 1))
            if [ $error_count -ge 3 ]; then
                # RPC doesn't support historical state queries, fall back to 0
                echo "0"
                return
            fi
            # Try moving to more recent blocks
            low=$((mid + 1))
        elif [ "$result" = "0x" ] || [ -z "$result" ]; then
            # No code at this block, contract deployed later
            low=$((mid + 1))
        else
            # Code exists, contract may have been deployed earlier or at this block
            high=$mid
        fi
    done
    
    echo "$low"
}

# Fetch role hashes from the contract itself (removes hardcoding errors)
echo "Fetching role hashes from contract..."
DEFAULT_ADMIN_ROLE="0x0000000000000000000000000000000000000000000000000000000000000000"
PAUSER_ROLE=$(cast call "$CONTRACT_ADDRESS" "PAUSER_ROLE()(bytes32)" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')
TREASURER_ROLE=$(cast call "$CONTRACT_ADDRESS" "TREASURER_ROLE()(bytes32)" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')
TOKEN_CONFIG_ROLE=$(cast call "$CONTRACT_ADDRESS" "TOKEN_CONFIG_ROLE()(bytes32)" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')

# Validate we got the role hashes
if [ -z "$PAUSER_ROLE" ] || [ -z "$TREASURER_ROLE" ] || [ -z "$TOKEN_CONFIG_ROLE" ]; then
    echo "Error: Failed to fetch role hashes from contract. Is this an Escrow contract?"
    exit 1
fi
echo "Role hashes fetched successfully."

# Auto-detect deployment block if not specified
if [ "$FROM_BLOCK" = "0" ]; then
    echo "Detecting contract deployment block (binary search)..."
    FROM_BLOCK=$(find_deployment_block)
    if [ "$FROM_BLOCK" = "0" ]; then
        echo "Warning: Could not detect deployment block, using block 0"
    else
        echo "Contract deployed at block $FROM_BLOCK"
    fi
elif [ "$FROM_BLOCK" != "0" ]; then
    echo "Using specified from-block: $FROM_BLOCK"
fi
echo ""

# Function to extract address from padded topic (last 40 chars)
extract_address() {
    local topic="$1"
    echo "0x${topic: -40}"
}

# Function to check if address is in list
contains_address() {
    local addr="$1"
    local list="$2"
    echo "$list" | grep -q "^${addr}$"
}

# Function to process a single role
process_role() {
    local role_name="$1"
    local role_hash="$2"
    local show_trace="$3"
    
    # Query RoleGranted events for this role
    local granted_raw=$(cast logs --from-block "$FROM_BLOCK" --address "$CONTRACT_ADDRESS" \
        "$ROLE_GRANTED_SIG" "$role_hash" \
        --rpc-url "$RPC_URL" 2>/dev/null)
    
    # Query RoleRevoked events for this role
    local revoked_raw=$(cast logs --from-block "$FROM_BLOCK" --address "$CONTRACT_ADDRESS" \
        "$ROLE_REVOKED_SIG" "$role_hash" \
        --rpc-url "$RPC_URL" 2>/dev/null)
    
    # Parse granted events: extract block number and account (topics[2]), sender (topics[3])
    # Topics: [0]=event_sig, [1]=role, [2]=account, [3]=sender
    local granted_events=""
    local current_block=""
    local topic_count=0
    local topic1="" topic2="" topic3="" topic4=""
    
    while IFS= read -r line; do
        if [[ "$line" =~ blockNumber:\ ([0-9]+) ]]; then
            current_block="${BASH_REMATCH[1]}"
        elif [[ "$line" =~ ^[[:space:]]+(0x[0-9a-fA-F]{64})[[:space:]]*$ ]]; then
            topic_count=$((topic_count + 1))
            case $topic_count in
                1) topic1="${BASH_REMATCH[1]}" ;;  # event sig
                2) topic2="${BASH_REMATCH[1]}" ;;  # role
                3) topic3="${BASH_REMATCH[1]}" ;;  # account
                4) 
                    topic4="${BASH_REMATCH[1]}"    # sender
                    local account=$(extract_address "$topic3")
                    local sender=$(extract_address "$topic4")
                    granted_events+="G $current_block $account $sender"$'\n'
                    topic_count=0
                    ;;
            esac
        elif [[ "$line" =~ ^-\ address: ]]; then
            topic_count=0
        fi
    done <<< "$granted_raw"
    
    # Parse revoked events similarly
    local revoked_events=""
    current_block=""
    topic_count=0
    
    while IFS= read -r line; do
        if [[ "$line" =~ blockNumber:\ ([0-9]+) ]]; then
            current_block="${BASH_REMATCH[1]}"
        elif [[ "$line" =~ ^[[:space:]]+(0x[0-9a-fA-F]{64})[[:space:]]*$ ]]; then
            topic_count=$((topic_count + 1))
            case $topic_count in
                1) topic1="${BASH_REMATCH[1]}" ;;  # event sig
                2) topic2="${BASH_REMATCH[1]}" ;;  # role
                3) topic3="${BASH_REMATCH[1]}" ;;  # account
                4) 
                    topic4="${BASH_REMATCH[1]}"    # sender
                    local account=$(extract_address "$topic3")
                    local sender=$(extract_address "$topic4")
                    revoked_events+="R $current_block $account $sender"$'\n'
                    topic_count=0
                    ;;
            esac
        elif [[ "$line" =~ ^-\ address: ]]; then
            topic_count=0
        fi
    done <<< "$revoked_raw"
    
    # Combine and sort by block number
    local all_events=$(echo -e "${granted_events}${revoked_events}" | grep -v "^$" | sort -t' ' -k2 -n)
    
    # Print trace if enabled
    if [ "$show_trace" = true ]; then
        echo "=== $role_name Events ==="
        if [ -z "$all_events" ]; then
            echo "(no events)"
        else
            while IFS=' ' read -r event_type block_num account sender; do
                if [ -z "$event_type" ]; then
                    continue
                fi
                if [ "$event_type" = "G" ]; then
                    echo "Block $block_num: Granted $account (by $sender)"
                else
                    echo "Block $block_num: Revoked $account (by $sender)"
                fi
            done <<< "$all_events"
        fi
        echo ""
    fi
    
    # Simulate state: track which addresses currently have the role
    # Use a simple newline-separated list instead of associative array
    local holders=""
    
    while IFS=' ' read -r event_type block_num account sender; do
        if [ -z "$event_type" ]; then
            continue
        fi
        
        if [ "$event_type" = "G" ]; then
            # Add if not already present
            if ! echo "$holders" | grep -q "^${account}$"; then
                holders+="$account"$'\n'
            fi
        elif [ "$event_type" = "R" ]; then
            # Remove from list
            holders=$(echo "$holders" | grep -v "^${account}$" || true)
        fi
    done <<< "$all_events"
    
    # Output current holders for this role (only in non-trace or final state section)
    if [ "$show_trace" = false ]; then
        echo "$role_name:"
        holders=$(echo "$holders" | grep -v "^$" || true)
        if [ -z "$holders" ]; then
            echo "  (none)"
        else
            echo "$holders" | while read -r addr; do
                if [ -n "$addr" ]; then
                    echo "  -> $addr"
                fi
            done
        fi
        echo ""
    fi
}

# Main execution
echo "=== Role State for $CONTRACT_ADDRESS ==="
echo ""

if [ "$TRACE" = true ]; then
    # First show all traces
    process_role "DEFAULT_ADMIN_ROLE" "$DEFAULT_ADMIN_ROLE" true
    process_role "PAUSER_ROLE" "$PAUSER_ROLE" true
    process_role "TREASURER_ROLE" "$TREASURER_ROLE" true
    process_role "TOKEN_CONFIG_ROLE" "$TOKEN_CONFIG_ROLE" true
    
    echo "=== Final Role State ==="
    echo ""
fi

# Show final state
process_role "DEFAULT_ADMIN_ROLE" "$DEFAULT_ADMIN_ROLE" false
process_role "PAUSER_ROLE" "$PAUSER_ROLE" false
process_role "TREASURER_ROLE" "$TREASURER_ROLE" false
process_role "TOKEN_CONFIG_ROLE" "$TOKEN_CONFIG_ROLE" false
