# WASM System Specification

This document describes the WASM (WebAssembly) execution system for running guest modules that can make RPC calls to Ethereum networks.

## Overview

The WASM system allows you to write code in multiple languages that runs in a sandboxed WebAssembly environment. These modules can make read-only Ethereum JSON-RPC calls through a file-based communication protocol.

## Architecture

```
┌─────────────────┐
│  WASM Server    │  (Node.js/Express)
│  /wasm/run      │
└────────┬────────┘
         │
         │ spawns wasmtime
         ▼
┌─────────────────┐
│  Wasmtime       │  (WASM Runtime)
│  ┌───────────┐  │
│  │ Guest WASM│  │  (Your code: Rust/Python)
│  │ Module    │  │
│  └─────┬─────┘  │
│        │        │
│        │ file-based RPC
│        ▼        │
│  ┌───────────┐  │
│  │ RPC Bridge│  │  (File I/O)
│  └─────┬─────┘  │
└────────┼────────┘
         │
         ▼
┌──────────────────┐
│  RPC Simulator   │  (Ethereum RPC)
│  - eth_getBalance│
│  - eth_call      │
│  - etc.          │
└──────────────────┘
```

## Supported Languages

### Rust (Recommended)

Rust compiles directly to WASM and is the primary supported language.

**Example Structure:**
```rust
// Required exports
#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 { ... }

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: u32) { ... }

// Main entry point
#[no_mangle]
pub extern "C" fn run() {
    // Your code here
    // Output JSON to stdout
    println!("{}", json_output);
}
```

**See:** `examples/wasm/rpc-example/` for a complete Rust example.

### Python (Experimental)

Python can be compiled to WASM using MicroPython or Pyodide, but requires additional setup.

**See:** `examples/wasm/balance-math/` for a Python example.

## RPC Communication Protocol

### File-Based Protocol

WASM modules communicate with the host via a file-based protocol (due to Wasmtime limitations):

1. **Guest writes request** → `wasm_rpc_request.json` in work directory
2. **Host polls** → Processes requests via `processWasmRpcRequests()`
3. **Host writes response** → `wasm_rpc_response.json`
4. **Guest reads response** → Cleans up files

### Environment Variables

The host sets these environment variables for the WASM module:

- `WASM_RPC_WORK_DIR` - Path to the work directory (pre-opened via `--dir` flag)
- `WASM_RPC_REQUEST_FILE` - Request filename (default: `wasm_rpc_request.json`)
- `WASM_RPC_RESPONSE_FILE` - Response filename (default: `wasm_rpc_response.json`)

### Making RPC Calls

#### Rust Example

```rust
use serde_json::json;

fn host_rpc(req: &str) -> Result<String, String> {
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    
    let work_dir = env::var("WASM_RPC_WORK_DIR")?;
    let request_file = env::var("WASM_RPC_REQUEST_FILE")
        .unwrap_or_else(|_| "wasm_rpc_request.json".to_string());
    let response_file = env::var("WASM_RPC_RESPONSE_FILE")
        .unwrap_or_else(|_| "wasm_rpc_response.json".to_string());
    
    let request_path = PathBuf::from(&work_dir).join(&request_file);
    let response_path = PathBuf::from(&work_dir).join(&response_file);
    
    // Write request
    fs::write(&request_path, req)?;
    
    // Poll for response (with timeout)
    for _ in 0..500 {  // 5 seconds max
        if response_path.exists() {
            let response = fs::read_to_string(&response_path)?;
            let _ = fs::remove_file(&request_path);
            let _ = fs::remove_file(&response_path);
            return Ok(response);
        }
        // Spin wait
        for _ in 0..1000 {}
    }
    
    Err("RPC call timeout".to_string())
}

// Usage
let request = json!({
    "jsonrpc": "2.0",
    "id": 1,
    "method": "eth_getBalance",
    "params": ["0x0", "latest"]
});

let response_str = host_rpc(&request.to_string())?;
let response: serde_json::Value = serde_json::from_str(&response_str)?;
```

#### Python Example

```python
import json
import os
from pathlib import Path

def host_rpc(request: str) -> str:
    work_dir = os.environ.get("WASM_RPC_WORK_DIR")
    request_file = os.environ.get("WASM_RPC_REQUEST_FILE", "wasm_rpc_request.json")
    response_file = os.environ.get("WASM_RPC_RESPONSE_FILE", "wasm_rpc_response.json")
    
    request_path = Path(work_dir) / request_file
    response_path = Path(work_dir) / response_file
    
    # Write request
    with open(request_path, 'w') as f:
        f.write(request)
    
    # Poll for response
    for _ in range(500):
        if response_path.exists():
            with open(response_path, 'r') as f:
                response = f.read()
            request_path.unlink()
            response_path.unlink()
            return response
        time.sleep(0.01)
    
    raise TimeoutError("RPC call timeout")

# Usage
request = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "eth_getBalance",
    "params": ["0x0", "latest"]
}

response_str = host_rpc(json.dumps(request))
response = json.loads(response_str)
```

## Supported RPC Methods

The following read-only Ethereum JSON-RPC methods are supported:

- `eth_blockNumber` - Get latest block number
- `eth_chainId` - Get chain ID
- `eth_getBalance` - Get account balance
- `eth_getTransactionCount` - Get account nonce
- `eth_getCode` - Get contract code
- `eth_getStorageAt` - Get storage value
- `eth_call` - Execute contract call
- `eth_estimateGas` - Estimate gas for transaction
- `eth_getBlockByNumber` - Get block by number
- `eth_getBlockByHash` - Get block by hash
- `net_version` - Get network version
- `web3_clientVersion` - Get client version

**Note:** Write operations (sending transactions) are not supported for security reasons.

## WASM Module Requirements

### Required Exports

Your WASM module must export these functions:

1. **`alloc(len: u32) -> *mut u8`** - Allocate memory (for future host imports)
2. **`dealloc(ptr: *mut u8, len: u32)`** - Deallocate memory
3. **`run()`** - Main entry point (called by host)

### Output Format

The `run()` function must output JSON to **stdout**. The server expects a single JSON object:

```json
{
  "ok": true,
  "result": { ... }
}
```

Or on error:

```json
{
  "ok": false,
  "error": "error message"
}
```

### Input

Input is passed via **stdin** as a single JSON line. Access it in your code:

```rust
// Rust
use std::io::{self, BufRead};
let stdin = io::stdin();
let input: serde_json::Value = serde_json::from_str(
    &stdin.lock().lines().next().unwrap().unwrap()
)?;
```

```python
# Python
import json
import sys
input_data = json.loads(sys.stdin.readline())
```

## Building WASM Modules

### Rust

```bash
cd examples/wasm/rpc-example
cargo build --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/rpc_example.wasm ../rpc-example.wasm
```

### Python

```bash
cd examples/wasm/balance-math
./build.sh  # Uses Docker with MicroPython
```

## Executing WASM Modules

### Via HTTP API

```bash
# Using curl
curl -X POST http://localhost:8080/wasm/run \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "test-123",
    "wasmB64": "'$(base64 -i examples/wasm/rpc-example.wasm)'",
    "timeoutMs": 5000,
    "input": {"address": "0x0"}
  }'
```

### Via TypeScript Client

```bash
bun run examples/wasm/run-wasm.ts \
  --wasm examples/wasm/rpc-example.wasm \
  --input '{"address": "0x0"}' \
  --timeout 5000
```

### Via Python Client

```python
import requests
import base64

with open("examples/wasm/rpc-example.wasm", "rb") as f:
    wasm_b64 = base64.b64encode(f.read()).decode()

response = requests.post(
    "http://localhost:8080/wasm/run",
    json={
        "jobId": "test-123",
        "wasmB64": wasm_b64,
        "timeoutMs": 5000,
        "input": {"address": "0x0"}
    }
)
print(response.json())
```

## Using in Workflows

WASM modules can be integrated into workflows for validation and computation:

### Workflow Integration

1. **Upload WASM** - Store WASM binary (e.g., in IPFS)
2. **Reference in Workflow** - Include WASM hash/URL in workflow definition
3. **Execute on Trigger** - Workflow executor calls WASM server
4. **Process Results** - Use WASM output in workflow logic

### Example Workflow Step

```json
{
  "type": "wasm_validation",
  "wasmHash": "Qm...",
  "input": {
    "address": "{{trigger.address}}",
    "minBalance": "1000000000000000000"
  },
  "timeout": 5000
}
```

### Validation Use Case

WASM modules are ideal for:
- **Balance checks** - Verify account has sufficient funds
- **Contract state validation** - Check contract storage values
- **Computation** - Perform calculations on blockchain data
- **Data transformation** - Process and format RPC responses

## Security Considerations

1. **Sandboxed Execution** - WASM modules run in isolated environment
2. **Read-Only RPC** - Only read operations are allowed
3. **Resource Limits** - Timeout, memory, and output size limits
4. **No Network Access** - Modules cannot make external HTTP calls
5. **File System Access** - Limited to pre-opened work directory

## Configuration

### Server Configuration

Set these environment variables:

- `WASM_CACHE_DIR` - Directory for caching WASM files (default: `/tmp/wasm-cache`)
- `RPC_URL_1` - Ethereum mainnet RPC URL
- `RPC_URL_11155111` - Sepolia testnet RPC URL
- `MAX_BODY_BYTES` - Maximum request body size (default: 12MB)

### Docker Deployment

The `sandbox` service in `docker-compose.yml` provides a minimal WASM execution environment:

```yaml
sandbox:
  build:
    dockerfile: Dockerfile.wasmtime
  environment:
    - API_ONLY=true
    - WASM_CACHE_DIR=/tmp/wasm-cache
    - RPC_URL_1=https://eth.llamarpc.com
    - RPC_URL_11155111=https://rpc.sepolia.org
```

## Examples

- **`rpc-example`** - Rust example demonstrating RPC calls
- **`balance-math`** - Python example reading balance and doing math
- **`sum`** - Simple Rust example (no RPC)

## Limitations

1. **File-Based RPC** - Current implementation uses files (future: proper host imports)
2. **No Async** - RPC calls are synchronous with polling
3. **Python Support** - Experimental, requires MicroPython/Pyodide
4. **Size Limits** - WASM modules limited to 10MB by default
5. **Timeout** - Maximum execution time is 30 seconds by default

## Future Enhancements

1. **Proper Host Imports** - Direct function calls instead of file-based protocol
2. **Async RPC** - Non-blocking RPC calls
3. **More Languages** - Better support for Python, JavaScript, etc.
4. **Streaming** - Support for streaming large responses
5. **Caching** - Better WASM module caching and versioning

## API Reference

### POST `/wasm/run`

Execute a WASM module.

**Request:**
```json
{
  "jobId": "unique-job-id",
  "wasmB64": "base64-encoded-wasm-bytes",
  "wasmHash": "optional-sha256-hex",
  "timeoutMs": 5000,
  "input": {},
  "maxStdoutBytes": 262144,
  "maxStderrBytes": 262144
}
```

**Response:**
```json
{
  "jobId": "unique-job-id",
  "ok": true,
  "result": {},
  "stderr": "",
  "durationMs": 123
}
```

### GET `/wasm/health`

Health check endpoint.

**Response:**
```json
{
  "ok": true
}
```

## See Also

- [Rust RPC Example](./rpc-example/README.md)
- [Python Balance Math Example](./balance-math/README.md)
- [WASM Server Implementation](../../src/server.ts)
- [RPC Host Bridge](../../src/utils/wasmHostBridge.ts)
