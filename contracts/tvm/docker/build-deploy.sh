#!/bin/bash
set -e

echo "🚀 Starting Tron node for build-time deployment..."

# Start tron-quickstart in background
cd /tron
./quickstart v1.0.4 &
TRON_PID=$!

echo "⏳ Waiting for Tron node to be ready (this may take up to 90 seconds)..."

# Wait for node to be fully ready
MAX_WAIT=120
ELAPSED=0

# Check if node is responding
while true; do
    if curl -s -f --max-time 2 "http://localhost:9090/wallet/getnowblock" > /dev/null 2>&1; then
        echo "✅ Node is responding to API calls"
        break
    fi
    
    if [ $ELAPSED -ge $MAX_WAIT ]; then
        echo "❌ Timeout waiting for Tron node after ${MAX_WAIT}s"
        kill -9 $TRON_PID 2>/dev/null || true
        exit 1
    fi
    
    sleep 5
    ELAPSED=$((ELAPSED + 5))
    echo "   Still waiting... (${ELAPSED}s/${MAX_WAIT}s)"
done

# Give it a bit more time to fully stabilize
echo "⏳ Allowing node to stabilize..."
sleep 15

echo "📦 Deploying contracts..."
cd /contracts/tvm

# Deploy contracts using tronbox
tronbox migrate --network development --reset || {
    echo "❌ Contract deployment failed"
    kill -9 $TRON_PID 2>/dev/null || true
    exit 1
}

echo "✅ Contracts deployed successfully"

# Save deployment addresses
echo "💾 Saving contract addresses..."
mkdir -p /var/www/deploymentAddresses

# Extract contract addresses from migration output
# We'll create a simple script to get the addresses
cat > /tmp/get-addresses.js << 'EOF'
const FulfillmentProxy = artifacts.require('FulfillmentProxy');
const MockERC20 = artifacts.require('MockERC20');

module.exports = async function(callback) {
    try {
        const fulfillmentProxy = await FulfillmentProxy.deployed();
        const mockToken = await MockERC20.deployed();
        
        const addresses = {
            FulfillmentProxy: fulfillmentProxy.address,
            MockERC20: mockToken.address
        };
        
        console.log(JSON.stringify(addresses, null, 2));
        callback();
    } catch (error) {
        console.error('Error getting addresses:', error);
        callback(error);
    }
};
EOF

# Run the script to get addresses
tronbox exec /tmp/get-addresses.js --network development > /var/www/deploymentAddresses/addresses.json || {
    echo "⚠️ Warning: Could not save contract addresses"
}

# Also save individual address files for compatibility with EVM pattern
if [ -f /var/www/deploymentAddresses/addresses.json ]; then
    # Extract addresses using node
    node -e "
        const fs = require('fs');
        const addresses = JSON.parse(fs.readFileSync('/var/www/deploymentAddresses/addresses.json'));
        for (const [name, address] of Object.entries(addresses)) {
            fs.writeFileSync('/var/www/deploymentAddresses/' + name, address);
        }
    " || echo "⚠️ Warning: Could not create individual address files"
fi

echo "🪙 Minting test tokens..."
# Create mint script
cat > /tmp/mint-tokens.js << 'EOF'
const MockERC20 = artifacts.require('MockERC20');

module.exports = async function(callback) {
    try {
        const token = await MockERC20.deployed();
        
        // Test accounts to mint tokens to
        const testAccounts = [
            'TGehVcNhud84JDCGrNHKVz9jEAVKUpbuiv', // Default account 1
            'TWsm8HtU2A5eEzoT8ev8yaoFjHsXLLrckb', // Default account 2  
            'TNo59Khpq46FGf4sD7XSWYFNfYfbc8CqNK'  // Default account 3
        ];
        
        const mintAmount = '1000000000000'; // 1M tokens with 6 decimals
        
        for (const account of testAccounts) {
            console.log(`Minting ${mintAmount} tokens to ${account}...`);
            await token.mint(account, mintAmount);
        }
        
        console.log('✅ Tokens minted successfully');
        callback();
    } catch (error) {
        console.error('Error minting tokens:', error);
        callback(error);
    }
};
EOF

# Run the mint script
tronbox exec /tmp/mint-tokens.js --network development || {
    echo "⚠️ Warning: Could not mint test tokens"
}

echo "📸 Capturing node state..."

# Stop the node gracefully
kill -15 $TRON_PID 2>/dev/null || true

# Wait for graceful shutdown
SHUTDOWN_WAIT=30
SHUTDOWN_ELAPSED=0
while kill -0 $TRON_PID 2>/dev/null; do
    if [ $SHUTDOWN_ELAPSED -ge $SHUTDOWN_WAIT ]; then
        echo "⚠️ Node didn't stop gracefully, forcing..."
        kill -9 $TRON_PID 2>/dev/null || true
        break
    fi
    sleep 1
    SHUTDOWN_ELAPSED=$((SHUTDOWN_ELAPSED + 1))
done

echo "✅ Node stopped"

# Archive the database state
echo "📦 Archiving database state..."
cd /tron/FullNode
if [ -d "output-directory" ]; then
    tar czf /tron-state.tar.gz output-directory/
    echo "✅ State archived successfully"
else
    echo "⚠️ Warning: output-directory not found, state not archived"
fi

echo "🎉 Build-time deployment complete!"