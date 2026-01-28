# RPC Example WASM Module

This example demonstrates how to make read-only EVM JSON-RPC calls from a guest WASM module running under Wasmtime.

## Features

- Exports `alloc(len)` function for host to allocate guest memory
- Provides `host_rpc(req)` helper function to call host RPC functions
- Implements `run()` function that demonstrates RPC calls (eth_blockNumber, eth_getBalance)

## Building

```bash
cd examples/wasm/rpc-example
./build.sh
```

This will:
1. Build the WASM module for `wasm32-wasip1` target
2. Copy the output to `examples/wasm/rpc-example.wasm`

## Usage

The WASM module can be executed via the WASM server:

```bash
bun run examples/wasm/run-wasm.ts --wasm examples/wasm/rpc-example.wasm --timeout 5000
```

## Implementation Notes

### Current Implementation (File-based Protocol)

Due to limitations in the Wasmtime JS npm package, the current implementation uses a file-based communication protocol:

1. Guest writes RPC request to `wasm_rpc_request.json` in work directory
2. Host polls and processes requests via `processWasmRpcRequests()`
3. Host writes response to `wasm_rpc_response.json`
4. Guest reads response and cleans up

### Future Enhancement (Proper Wasmtime Host Imports)

When a more complete Wasmtime JS binding is available, this can be upgraded to use proper host imports:

```rust
#[link(wasm_import_module = "host")]
extern "C" {
    fn rpc_call(req_ptr: u32, req_len: u32, resp_ptr_ptr: u32) -> u32;
}
```

The host would:
1. Read request from guest memory (req_ptr, req_len)
2. Process via simulator
3. Call guest `alloc()` to allocate response memory
4. Write response to guest memory
5. Store pointer at resp_ptr_ptr
6. Return response length

## Supported RPC Methods

The following read-only methods are supported:
- `eth_blockNumber`
- `eth_chainId`
- `net_version`
- `web3_clientVersion`
- `eth_getBalance`
- `eth_getTransactionCount`
- `eth_getCode`
- `eth_getStorageAt`
- `eth_call`
- `eth_estimateGas`
- `eth_getBlockByNumber`
- `eth_getBlockByHash`
- `eth_getTransactionByHash`
- `eth_getTransactionReceipt`

All write/state-changing methods (e.g., `eth_sendRawTransaction`) are rejected.

