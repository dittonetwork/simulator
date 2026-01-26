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
echo "Modules included:"
echo "  - rebalance:       Grid search yield optimization"
echo "  - emergency-check: Guard monitoring with skip support"
echo ""
echo "Usage:"
echo "  action: 'rebalance'       - Optimize vault allocations (default)"
echo "  action: 'emergency-check' - Check guards, activate emergency if needed"
