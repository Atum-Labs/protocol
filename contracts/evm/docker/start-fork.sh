#!/bin/bash

# Script to start an anvil fork and wait for it to be ready
# Usage: start-fork.sh <fork_url> <fork_block_number> [port]

set -e

FORK_URL="$1"
FORK_BLOCK_NUMBER="$2"
ANVIL_PORT="${3:-8545}"  # Default to 8545 if not provided
PID_FILE="/tmp/anvil.pid"

if [ -z "$FORK_URL" ] || [ -z "$FORK_BLOCK_NUMBER" ]; then
    echo "Usage: $0 <fork_url> <fork_block_number> [port]"
    exit 1
fi

echo "Starting anvil fork from $FORK_URL at block $FORK_BLOCK_NUMBER..."

# Start anvil in the background
anvil --host 0.0.0.0 --port "$ANVIL_PORT" --fork-url "$FORK_URL" --fork-block-number "$FORK_BLOCK_NUMBER" &
ANVIL_PID=$!

# Save PID to file
echo "$ANVIL_PID" > "$PID_FILE"

# Function to check if anvil is ready using PERMIT2 contract
check_anvil_ready() {
    # Check if PERMIT2 contract exists and has code
    if ! cast code "${PERMIT2_ADDRESS}" --rpc-url http://localhost:${ANVIL_PORT} 2>/dev/null | grep -v '^0x$' > /dev/null; then
        return 1
    fi
    
    return 0
}

# Wait for anvil to be ready with proper health check
echo "Waiting for anvil to be ready..."
while ! check_anvil_ready; do
    sleep 1
    if ! kill -0 $ANVIL_PID 2>/dev/null; then
        echo "Anvil process died unexpectedly"
        rm -f "$PID_FILE"
        exit 1
    fi
done
echo "Anvil is ready and running! PID: $ANVIL_PID" 
