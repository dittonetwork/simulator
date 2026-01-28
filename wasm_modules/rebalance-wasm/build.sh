#!/bin/bash
set -e

echo "=== Building Vault Automation WASM ==="

# Use wasm32-wasip1 target (wasm32-wasi is deprecated)
TARGET="wasm32-wasip1"

# Check if target is installed
if ! rustup target list | grep -q "$TARGET (installed)"; then
    echo "Installing $TARGET target..."
    rustup target add $TARGET
fi

# Build for WASM
echo "Building WASM module..."
cargo build --target $TARGET --release

# Copy WASM to project root
cp target/$TARGET/release/rebalance_wasm.wasm ./yield-optimizer.wasm

echo ""
echo "=== Build Complete ==="
echo ""
ls -lh yield-optimizer.wasm
echo ""
echo "Module: Yield Optimizer"
echo "  - Fetches vault data via VaultDataReader RPC"
echo "  - Runs grid search optimization"
echo "  - Returns optimal allocations for executeRebalance()"
echo ""
echo "Note: Emergency monitoring removed - updateAllGuards() auto-activates emergency mode"
