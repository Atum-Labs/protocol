#!/usr/bin/env bash
# Comprehensive Escrow inspection script
# Combines contract state (pause, token config) with access control (role holders)
# Usage: ./inspect_escrow.sh [--trace] [--from-block <block>] <rpc_url> <contract_address>
# Requires: cast, forge (foundry)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Print usage
usage() {
    echo "Usage: $0 [--trace] [--from-block <block>] <rpc_url> <contract_address>"
    echo ""
    echo "Arguments:"
    echo "  --trace              Show access control event trace grouped by role"
    echo "  --from-block <block> Starting block for event queries (use if auto-detection fails)"
    echo "  <rpc_url>            RPC URL for the target chain"
    echo "  <contract_address>   Escrow contract address to inspect"
    echo ""
    echo "Example:"
    echo "  $0 https://sepolia-rollup.arbitrum.io/rpc 0x31dB576e05b6Cc510f4382Be025A0e51f3f556b9"
    echo "  $0 --trace https://sepolia-rollup.arbitrum.io/rpc 0x31dB576e05b6Cc510f4382Be025A0e51f3f556b9"
    echo "  $0 --from-block 33259825 https://rpc-amoy.polygon.technology/ 0xBEc3fbF58e4115e373670C2A6F12f4bF0601E488"
    exit 1
}

# Parse arguments
TRACE_FLAG=""
FROM_BLOCK_FLAG=""
RPC_URL=""
CONTRACT_ADDRESS=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --trace)
            TRACE_FLAG="--trace"
            shift
            ;;
        --from-block)
            FROM_BLOCK_FLAG="--from-block $2"
            shift 2
            ;;
        --help|-h)
            usage
            ;;
        *)
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

echo "========================================"
echo "  ESCROW INSPECTION"
echo "  Contract: $CONTRACT_ADDRESS"
echo "========================================"
echo ""

# Section 1: Contract State (pause + token config)
echo "=== Contract State ==="
echo ""

# Run the Foundry script and extract logs
ESCROW_ADDRESS="$CONTRACT_ADDRESS" forge script \
    "$SCRIPT_DIR/GetEscrowState.s.sol" \
    --rpc-url "$RPC_URL" \
    -vvvv 2>&1 | grep -E "^\s*(Paused state:|Allowed tokens:|Token name:|Token symbol:|Fee Percentage|Max Fee|Min Fee|Token Decimals:|---)" | sed 's/^[[:space:]]*//'

echo ""

# Section 2: Access Control (role holders)
"$SCRIPT_DIR/get_role_state.sh" $TRACE_FLAG $FROM_BLOCK_FLAG "$RPC_URL" "$CONTRACT_ADDRESS"
