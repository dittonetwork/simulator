#!/bin/bash
# Build script for RPC example WASM module

set -e

echo "Building RPC example WASM module..."

# Build for wasm32-wasip1 target
cargo build --target wasm32-wasip1 --release

# Copy to examples/wasm directory (the library name is rpc_example.wasm)
cp target/wasm32-wasip1/release/rpc_example.wasm ../rpc-example.wasm

echo "Build complete: ../rpc-example.wasm"

