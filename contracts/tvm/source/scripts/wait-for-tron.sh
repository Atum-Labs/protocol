#!/bin/bash
set -e

echo "⏳ Waiting for TRON node to be ready..."

# Maximum wait time (seconds)
# Increase timeout for CI environments (slower startup + image download)
if [ -n "$CI" ]; then
    MAX_WAIT=300  # 5 minutes for CI (QEMU emulation is slow)
else
    MAX_WAIT=60   # 60 seconds for local development
fi
ELAPSED=0

# Function to check if node is ready (basic connectivity)
check_node_connectivity() {
    # First check admin endpoint with format=all parameter (what our tests actually use)
    if curl -s -f --max-time 2 "http://localhost:9090/admin/accounts?format=all" > /dev/null 2>&1; then
        return 0
    # Fallback to basic admin endpoint
    elif curl -s -f --max-time 1 http://localhost:9090/admin/accounts > /dev/null 2>&1; then
        return 0
    # Fallback to wallet endpoint for compatibility
    elif curl -s -f --max-time 1 http://localhost:9090/wallet/getnowblock > /dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Function to check if node has valid block data
check_block_data() {
    local BLOCK_NUM=$(curl -s --max-time 3 http://localhost:9090/wallet/getnowblock 2>/dev/null | jq -r '.block_header.raw_data.number // empty')
    if [ -n "$BLOCK_NUM" ] && [ "$BLOCK_NUM" != "null" ]; then
        echo "📦 Current block: #$BLOCK_NUM"
        return 0
    else
        return 1
    fi
}

# Function to check if admin accounts API returns valid data
check_admin_api() {
    # Always use format=all as that's what tests expect
    local RESPONSE
    local HTTP_CODE
    local CURL_OUTPUT
    
    # Capture both response and HTTP code
    CURL_OUTPUT=$(curl -s -w "\n__HTTP_CODE__:%{http_code}" --max-time 3 "http://localhost:9090/admin/accounts?format=all" 2>&1)
    local CURL_EXIT=$?
    
    # Extract HTTP code and response
    HTTP_CODE=$(echo "$CURL_OUTPUT" | grep -o "__HTTP_CODE__:[0-9]*" | cut -d: -f2)
    RESPONSE=$(echo "$CURL_OUTPUT" | sed '/__HTTP_CODE__:/d')
    
    # Debug output on certain intervals
    if [ $((ADMIN_CHECK_COUNT % 10)) -eq 1 ]; then
        echo "   📊 Admin API debug: curl_exit=$CURL_EXIT, http_code=$HTTP_CODE, response_length=${#RESPONSE}"
        if [ -n "$RESPONSE" ] && [ ${#RESPONSE} -gt 0 ]; then
            echo "   📊 Response preview (first 200 chars): ${RESPONSE:0:200}"
        fi
    fi
    
    # Check curl exit code
    if [ $CURL_EXIT -ne 0 ]; then
        if [ $((ADMIN_CHECK_COUNT % 20)) -eq 1 ]; then
            echo "   ⚠️  Curl failed with exit code $CURL_EXIT"
        fi
        return 1
    fi
    
    # Check HTTP status code
    if [ "$HTTP_CODE" != "200" ]; then
        if [ $((ADMIN_CHECK_COUNT % 20)) -eq 1 ]; then
            echo "   ⚠️  HTTP status code: $HTTP_CODE (expected 200)"
        fi
        return 1
    fi
    
    # Check if response is empty
    if [ -z "$RESPONSE" ] || [ ${#RESPONSE} -eq 0 ]; then
        if [ $((ADMIN_CHECK_COUNT % 20)) -eq 1 ]; then
            echo "   ⚠️  Empty response from admin API with format=all"
        fi
        return 1
    fi
    
    # Check for various possible valid responses
    # 1. Check for "Available Accounts" (standard response)
    if echo "$RESPONSE" | grep -q "Available Accounts" 2>/dev/null; then
        return 0
    fi
    
    # 2. Check if it starts with "(0)" which indicates account list
    if echo "$RESPONSE" | grep -q "^(0)" 2>/dev/null; then
        return 0
    fi
    
    # 3. Check if it contains private keys (another valid format)
    if echo "$RESPONSE" | grep -q "Private Keys" 2>/dev/null; then
        return 0
    fi
    
    # 4. Check if it contains hex addresses (41... pattern)
    if echo "$RESPONSE" | grep -q "41[0-9a-fA-F]\{38\}" 2>/dev/null; then
        return 0
    fi
    
    # 5. Check if it's JSON with accounts array
    if echo "$RESPONSE" | jq -e '.accounts' > /dev/null 2>&1; then
        return 0
    fi
    
    # 6. Check if response contains "Account #" pattern (another format seen)
    if echo "$RESPONSE" | grep -q "Account #" 2>/dev/null; then
        return 0
    fi
    
    # If we get a response but it doesn't match expected patterns, log it
    if [ $((ADMIN_CHECK_COUNT % 20)) -eq 1 ]; then
        echo "   ⚠️  Admin API responding with format=all but format unexpected."
        echo "   Full response (first 500 chars):"
        echo "${RESPONSE:0:500}"
        if [ ${#RESPONSE} -gt 500 ]; then
            echo "   ... (truncated, total length: ${#RESPONSE})"
        fi
    fi
    
    return 1
}

# Phase 1: Wait for basic connectivity
echo "🔌 Phase 1: Waiting for node connectivity..."
PHASE1_START=$ELAPSED

# Initial quick checks (first 2 seconds check every 100ms)
QUICK_CHECK_COUNT=0
while [ $QUICK_CHECK_COUNT -lt 20 ] && ! check_node_connectivity; do
    sleep 0.1
    QUICK_CHECK_COUNT=$((QUICK_CHECK_COUNT + 1))
done

# If still not ready, check less frequently
if ! check_node_connectivity; then
    ELAPSED=2
    echo "⏳ Node starting up..."
    
    while ! check_node_connectivity; do
        if [ $ELAPSED -ge $MAX_WAIT ]; then
            echo "❌ Timeout waiting for TRON node connectivity after ${MAX_WAIT}s"
            echo "💡 Debugging information:"
            echo "   Container status:"
            docker ps -a | grep tron-local-node || echo "   Container not found"
            echo "   Last 20 lines of container logs:"
            docker logs --tail 20 tron-local-node 2>&1 || echo "   Could not get logs"
            exit 1
        fi
        
        # Progress indicator every 5 seconds
        if [ $((ELAPSED % 5)) -eq 0 ]; then
            echo "⏳ Still waiting for connectivity... (${ELAPSED}s/${MAX_WAIT}s)"
        fi
        
        sleep 0.5
        ELAPSED=$((ELAPSED + 1))
    done
fi

echo "✅ Node is responding to HTTP requests (${ELAPSED}s)"

# Phase 2: Wait for valid data
echo "🔍 Phase 2: Waiting for node to fully initialize..."
PHASE2_START=$ELAPSED
BLOCK_READY=false
ADMIN_READY=false
ADMIN_CHECK_COUNT=0

while [ "$BLOCK_READY" = false ] || [ "$ADMIN_READY" = false ]; do
    if [ $ELAPSED -ge $MAX_WAIT ]; then
        echo "❌ Timeout waiting for TRON node to fully initialize after ${MAX_WAIT}s"
        echo "💡 Node status:"
        echo "   Block data available: $BLOCK_READY"
        echo "   Admin API available: $ADMIN_READY"
        echo "   Admin API check attempts: $ADMIN_CHECK_COUNT"
        echo ""
        echo "📊 Final diagnostics:"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "1. getnowblock response:"
        curl -s --max-time 3 http://localhost:9090/wallet/getnowblock 2>&1 | jq . 2>/dev/null | head -20 || curl -s --max-time 3 http://localhost:9090/wallet/getnowblock 2>&1 | head -20
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "2. admin/accounts?format=all response (what tests use):"
        ADMIN_RESPONSE=$(curl -s -w "\n__HTTP_CODE__:%{http_code}" --max-time 3 "http://localhost:9090/admin/accounts?format=all" 2>&1)
        echo "HTTP Code: $(echo "$ADMIN_RESPONSE" | grep -o "__HTTP_CODE__:[0-9]*" | cut -d: -f2)"
        echo "Response body:"
        echo "$ADMIN_RESPONSE" | sed '/__HTTP_CODE__:/d' | head -50
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "3. admin/accounts response (without format=all, for comparison):"
        curl -s -w "\nHTTP_CODE: %{http_code}\n" --max-time 3 "http://localhost:9090/admin/accounts" 2>&1 | head -20
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "4. Container logs (last 30 lines):"
        docker logs --tail 30 tron-local-node 2>&1 || echo "Could not get logs"
        exit 1
    fi
    
    # Check block data
    if [ "$BLOCK_READY" = false ] && check_block_data; then
        BLOCK_READY=true
        echo "✅ Block data is available"
    fi
    
    # Check admin API
    if [ "$ADMIN_READY" = false ]; then
        ADMIN_CHECK_COUNT=$((ADMIN_CHECK_COUNT + 1))
        if check_admin_api; then
            ADMIN_READY=true
            echo "✅ Admin accounts API is working with format=all (after $ADMIN_CHECK_COUNT attempts)"
        fi
    fi
    
    # If not both ready, wait and show progress
    if [ "$BLOCK_READY" = false ] || [ "$ADMIN_READY" = false ]; then
        # Progress indicator every 5 seconds
        if [ $(((ELAPSED - PHASE2_START) % 5)) -eq 0 ] && [ $ELAPSED -gt $PHASE2_START ]; then
            echo "⏳ Waiting for full initialization... (${ELAPSED}s/${MAX_WAIT}s)"
            [ "$BLOCK_READY" = false ] && echo "   ⏳ Block data: not ready"
            [ "$ADMIN_READY" = false ] && echo "   ⏳ Admin API: not ready (attempts: $ADMIN_CHECK_COUNT)"
        fi
        sleep 1
        ELAPSED=$((ELAPSED + 1))
    fi
done

echo "✅ Node is fully initialized (${ELAPSED}s total)"

# Get response time for diagnostics
RESPONSE=$(curl -s -w "\n%{time_total}" http://localhost:9090/wallet/getnowblock 2>/dev/null | tail -1)
echo "📊 API response time: ${RESPONSE}s"

# Give the node a moment to fully stabilize all services
echo "⏳ Allowing services to stabilize..."
sleep 2

echo "✅ TRON node is fully operational and ready for tests!" 