#!/bin/bash
set -e

echo "=== Testing Rebalance WASM Module Locally ==="
echo ""

# Check if wasmtime is installed
if ! command -v wasmtime &> /dev/null; then
    echo "❌ wasmtime not found. Please install it:"
    echo "   curl https://wasmtime.dev/install.sh -sSf | bash"
    exit 1
fi

# Check if WASM module exists
if [ ! -f "yield-optimizer.wasm" ]; then
    echo "❌ yield-optimizer.wasm not found. Please run ./build.sh first"
    exit 1
fi

echo "✅ Found wasmtime and yield-optimizer.wasm"
echo ""

# Test 1: Legacy Mode (Direct Protocol Data)
echo "============================================"
echo "TEST 1: Legacy Mode (Direct Protocol Data)"
echo "============================================"
echo ""

cat > /tmp/rebalance-test-legacy.json <<EOF
{
  "totalAssets": 10000000,
  "protocols": [
    {
      "ourBalance": 2000000,
      "poolSupply": 1000000000,
      "poolBorrow": 800000000,
      "utilization": 0.8,
      "currentApy": 0.04,
      "isBlocked": false,
      "protocolType": 1
    },
    {
      "ourBalance": 2000000,
      "poolSupply": 500000000,
      "poolBorrow": 400000000,
      "utilization": 0.8,
      "currentApy": 0.035,
      "isBlocked": false,
      "protocolType": 2
    },
    {
      "ourBalance": 2000000,
      "poolSupply": 200000000,
      "poolBorrow": 170000000,
      "utilization": 0.85,
      "currentApy": 0.08,
      "isBlocked": false,
      "protocolType": 3
    },
    {
      "ourBalance": 4000000,
      "poolSupply": 300000000,
      "poolBorrow": 240000000,
      "utilization": 0.8,
      "currentApy": 0.06,
      "isBlocked": false,
      "protocolType": 4
    }
  ],
  "blockedMask": 0,
  "config": {
    "stepPct": 5,
    "maxPoolShare": 0.2,
    "minAllocation": 100000
  }
}
EOF

echo "Input data:"
cat /tmp/rebalance-test-legacy.json | jq '.'
echo ""

echo "Running WASM module..."
echo ""

# Run with wasmtime
OUTPUT=$(cat /tmp/rebalance-test-legacy.json | wasmtime run --dir=. yield-optimizer.wasm 2>&1)

# Separate stderr (logs) and stdout (JSON result)
LOGS=$(echo "$OUTPUT" | grep '^\[WASM' || true)
RESULT=$(echo "$OUTPUT" | grep -v '^\[WASM' | tail -1)

echo "--- WASM Logs ---"
echo "$LOGS"
echo ""

echo "--- WASM Output ---"
echo "$RESULT" | jq '.'
echo ""

# Parse and display key results
if echo "$RESULT" | jq -e '.result.success' > /dev/null 2>&1; then
    echo "✅ Optimization succeeded!"
    echo ""
    echo "Key Results:"
    echo "  Expected APY: $(echo "$RESULT" | jq -r '.result.expectedApyWeighted * 100')%"
    echo "  Expected 12h Return: \$$(echo "$RESULT" | jq -r '.result.expectedReturn12h')"
    echo "  Scenarios Evaluated: $(echo "$RESULT" | jq -r '.result.scenariosEvaluated')"
    echo "  Time: $(echo "$RESULT" | jq -r '.result.timeMs')ms"
    echo ""
    echo "Allocations:"
    echo "$RESULT" | jq -r '.result.allocationsDecimal | to_entries[] | "  Protocol \(.key): $\(.value | floor)"'
    echo ""
    echo "Weights:"
    echo "$RESULT" | jq -r '.result.weights | to_entries[] | "  Protocol \(.key): \(.value * 100 | floor)%"'
    echo ""
    echo "APYs:"
    echo "$RESULT" | jq -r '.result.apys | to_entries[] | "  Protocol \(.key): \(.value * 100)%"'
else
    echo "❌ Optimization failed"
    echo "$RESULT" | jq -r '.result.error // "Unknown error"'
fi

echo ""
echo "============================================"
echo "TEST 2: RPC Mode (requires RPC server)"
echo "============================================"
echo ""
echo "ℹ️  RPC mode requires:"
echo "  1. WASM_RPC_WORK_DIR environment variable"
echo "  2. RPC proxy server running"
echo "  3. Deployed VaultDataReader contract"
echo ""
echo "Example RPC mode input:"

cat <<EOF
{
  "vaultDataReader": "0x...",
  "vault": "0x...",
  "protocolTypes": [1, 2, 3, 4],
  "pools": [
    "0xAavePool...",
    "0xSparkPool...",
    "0xFluidVault...",
    "0xMorphoVault..."
  ],
  "chainId": 84532,
  "config": {
    "stepPct": 1,
    "maxPoolShare": 0.2,
    "minAllocation": 1000
  }
}
EOF

echo ""
echo "To test RPC mode:"
echo "  export WASM_RPC_WORK_DIR=/tmp"
echo "  # Start RPC proxy server"
echo "  echo '{...rpc-input...}' | wasmtime run --dir=/tmp yield-optimizer.wasm"
echo ""

# Cleanup
rm -f /tmp/rebalance-test-legacy.json

echo "=== Test Complete ==="
