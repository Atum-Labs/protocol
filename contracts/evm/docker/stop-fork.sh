#!/bin/bash

# Script to stop the anvil fork process
# Usage: stop-fork.sh

set -e

PID_FILE="/tmp/anvil.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "No PID file found at $PID_FILE - anvil may not be running"
    exit 0
fi

ANVIL_PID=$(cat "$PID_FILE")

if [ -z "$ANVIL_PID" ]; then
    echo "Empty PID file - removing it"
    rm -f "$PID_FILE"
    exit 0
fi

echo "Stopping anvil process (PID: $ANVIL_PID)..."

# Check if process is still running
if kill -0 "$ANVIL_PID" 2>/dev/null; then
    # Kill the process
    kill "$ANVIL_PID"
    
    # Wait for process to exit
    wait "$ANVIL_PID" 2>/dev/null || true
    
    echo "Anvil process stopped successfully"
else
    echo "Anvil process (PID: $ANVIL_PID) was not running"
fi

# Clean up PID file
rm -f "$PID_FILE" 