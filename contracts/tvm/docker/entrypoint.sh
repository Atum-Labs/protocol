#!/bin/bash
set -e

echo "🚀 Starting Tron devnet container..."

# Copy our deterministic accounts configuration
echo "📝 Setting up deterministic test accounts..."
mkdir -p /config
cp /contracts/tvm/docker/accounts.json /config/accounts.json

# Start the main Tron node first
echo "🚀 Starting Tron node..."
cd /tron
./quickstart v1.0.4 &
TRON_PID=$!

# Wait for node to be ready
echo "⏳ Waiting for node to be ready (this may take up to 90 seconds)..."
MAX_WAIT=120
ELAPSED=0

while true; do
    if curl -s -f --max-time 2 "http://localhost:9090/wallet/getnowblock" > /dev/null 2>&1; then
        echo "✅ Node is responding to API calls"
        break
    fi
    
    if [ $ELAPSED -ge $MAX_WAIT ]; then
        echo "❌ Timeout waiting for node after ${MAX_WAIT}s"
        exit 1
    fi
    
    sleep 5
    ELAPSED=$((ELAPSED + 5))
    echo "   Still waiting... (${ELAPSED}s/${MAX_WAIT}s)"
done

# Allow stabilization
echo "⏳ Allowing node to stabilize..."
sleep 15

# Deploy contracts (migrations will handle deployment, address saving, and token minting)
cd /contracts/tvm
echo "📦 Deploying contracts and setting up test environment..."
mkdir -p /var/www/deploymentAddresses

# Check if contracts are already compiled
if [ -d "build/contracts" ] && [ "$(ls -A build/contracts)" ]; then
    echo "✅ Using pre-compiled contracts from build phase"
else
    echo "📝 Compiling contracts (this may take 30-45 seconds)..."
    tronbox compile
fi

# Run all migrations - this will:
# 1. Deploy Migrations contract
# 2. Deploy FulfillmentProxy contract  
# 3. Deploy MockERC20 token
# 4. Deploy Permit2 contract
# 5. Deploy Escrow contract
# 6. Save all contract addresses
# 7. Mint tokens to test accounts
tronbox migrate --network development --reset || {
    echo "⚠️ Contract deployment failed, continuing anyway..."
    # Create empty marker files so healthcheck knows deployment failed
    touch /var/www/deploymentAddresses/.deployment_failed
}

# Verify that critical contract address files were created
echo "🔍 Verifying contract deployment..."
REQUIRED_FILES=("FulfillmentProxy" "MockERC20" "Permit2" "Escrow")
MISSING_FILES=()

for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "/var/www/deploymentAddresses/$file" ]; then
        MISSING_FILES+=("$file")
    fi
done

if [ ${#MISSING_FILES[@]} -gt 0 ]; then
    echo "❌ Critical error: Contract address files missing: ${MISSING_FILES[*]}"
    echo "❌ This indicates migrations did not complete successfully"
    echo "❌ Container cannot function properly"
    echo "❌ Health checks will fail until this is resolved"
    
    # Mark deployment as failed so health check will fail
    touch /var/www/deploymentAddresses/.deployment_failed
    
    # Don't exit - keep container running so health checks can report unhealthy
    # This ensures docker compose up --wait will properly detect the failure
else
    echo "✅ All contract addresses verified"
fi

# Set up Permit2 approvals for all test accounts
# This runs after all migrations complete (contracts must be deployed and tokens minted)
if [ ! -f /var/www/deploymentAddresses/.deployment_failed ]; then
    echo "🔐 Running Permit2 approval script for test accounts..."
    cd /contracts/tvm
    node docker/set_permit2_approvals.js || {
        echo "⚠️ Failed to set Permit2 approvals, continuing anyway..."
    }
else
    echo "⚠️ Skipping Permit2 approvals setup due to deployment failure"
fi

# Start HTTP server for contract addresses on port 80
echo "🌐 Starting HTTP server for contract addresses on port 80..."
# Try busybox first, fallback to Node.js if not available
if command -v busybox &> /dev/null; then
    busybox httpd -f -p 80 -h /var/www &
else
    echo "  Using Node.js http-server as busybox is not available..."
    cd /var/www && npx http-server -p 80 --silent &
fi

echo "✅ Tron devnet ready!"

# Keep the container running
wait $TRON_PID