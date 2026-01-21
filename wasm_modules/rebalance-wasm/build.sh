#!/bin/bash
set -e

echo "=== Building Yield Optimizer WASM ==="

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

echo "✅ Build complete: yield-optimizer.wasm"
ls -lh yield-optimizer.wasm
