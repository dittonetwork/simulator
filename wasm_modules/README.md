# Ditto WASM Modules

Custom WebAssembly modules for Ditto Network workflow automation. WASM enables complex off-chain computation with on-chain execution.

## Available Modules

| Module | Description |
|--------|-------------|
| [rebalance-wasm](./rebalance-wasm/) | Yield optimization for DeFi vaults |

---

## Overview

### What are Ditto WASM Modules?

WASM modules are sandboxed programs that execute during workflow runs. They can:

- **Read on-chain state** via RPC calls
- **Perform complex computations** (optimization, simulation, validation)
- **Return values** for subsequent workflow steps
- **Control execution flow** (skip steps, abort workflows)

### Why WASM?

| Feature | Benefit |
|---------|---------|
| **Deterministic** | Same input = same output across all executors |
| **Sandboxed** | No filesystem/network access (except controlled RPC) |
| **Portable** | Runs on any executor regardless of architecture |
| **Efficient** | Near-native performance for compute-heavy tasks |
| **Verifiable** | Content-addressed via IPFS hash |

### Use Cases

- **Yield optimization** - Find optimal allocations across DeFi protocols
- **Arbitrage detection** - Calculate profitable trade routes
- **Risk assessment** - Validate positions against safety thresholds
- **Conditional execution** - Skip steps based on on-chain state

---

## Creating WASM Modules

### Prerequisites

```bash
# Rust toolchain with WASM target
rustup target add wasm32-wasip1

# Optional: wasmtime for local testing
curl https://wasmtime.dev/install.sh -sSf | bash
```

### Project Structure

```
my-wasm-module/
├── Cargo.toml          # Rust dependencies
├── build.sh            # Build script
├── src/
│   ├── lib.rs          # Entry point (required)
│   ├── common.rs       # Shared utilities
│   └── my_logic/
│       └── mod.rs      # Your implementation
└── test-input.json     # Test data
```

### Cargo.toml

```toml
[package]
name = "my-wasm-module"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]  # Required for WASM

[dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

[profile.release]
opt-level = "s"          # Optimize for size
lto = true               # Link-time optimization
```

### Entry Point (lib.rs)

```rust
use std::io::{self, Read};

mod common;
mod my_logic;

fn main() {
    // Read JSON input from stdin
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();

    let json: serde_json::Value = serde_json::from_str(&input).unwrap();

    // Dispatch based on action field
    match json.get("action").and_then(|v| v.as_str()) {
        Some("my-action") => my_logic::run(&json),
        Some(action) => output_error(&format!("Unknown action: {}", action)),
        None => output_error("Missing 'action' field"),
    }
}

fn output_error(msg: &str) {
    println!(r#"{{"ok":false,"error":"{}"}}"#, msg);
}
```

### Build Script

```bash
#!/bin/bash
set -e

cargo build --target wasm32-wasip1 --release

cp target/wasm32-wasip1/release/my_module.wasm ./my-module.wasm

echo "Built: my-module.wasm ($(du -h my-module.wasm | cut -f1))"
```

---

## Module Architecture

### Input/Output Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Executor  │────▶│    WASM     │────▶│   Output    │
│             │     │   Module    │     │    JSON     │
│  - Input    │     │             │     │             │
│    JSON     │     │  - Parse    │     │  - ok       │
│  - RPC      │     │  - Compute  │     │  - result   │
│    Proxy    │     │  - Output   │     │  - value    │
└─────────────┘     └─────────────┘     └─────────────┘
      │                   │
      │    RPC Calls      │
      └───────────────────┘
```

### Output Format

WASM modules must output JSON to stdout:

```json
{
  "ok": true,
  "result": {
    "success": true,
    "value": ["0x...", "0x..."],
    "customField": 123
  }
}
```

**Special fields:**

| Field | Type | Purpose |
|-------|------|---------|
| `ok` | bool | Top-level success indicator |
| `result.value` | any | Extracted by `$wasm:module-id` references |
| `result.skipRemainingSteps` | bool | If true, skip all subsequent steps |

### Action Dispatching

Single WASM binary can handle multiple actions:

```rust
match json.get("action").and_then(|v| v.as_str()) {
    Some("rebalance") => rebalance::run(&json),
    Some("validate") => validate::run(&json),
    Some("estimate") => estimate::run(&json),
    _ => output_error("Unknown action"),
}
```

### Logging

Logs go to stderr (captured by executor):

```rust
macro_rules! log_info {
    ($($arg:tt)*) => {
        eprintln!("[WASM:INFO] {}", format!($($arg)*));
    };
}

log_info!("Processing {} protocols", protocols.len());
```

---

## RPC Integration

WASM modules can read on-chain state via the executor's RPC proxy.

### How It Works

1. WASM writes RPC request to `$WASM_RPC_WORK_DIR/rpc_request.json`
2. WASM reads response from `$WASM_RPC_WORK_DIR/rpc_response.json`
3. Executor intercepts file operations and proxies to actual RPC

### Making RPC Calls

```rust
use serde_json::json;

fn rpc_call(method: &str, params: Vec<serde_json::Value>) -> Result<Value, String> {
    let work_dir = std::env::var("WASM_RPC_WORK_DIR")
        .map_err(|_| "WASM_RPC_WORK_DIR not set")?;

    let request = json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": 1
    });

    // Write request
    std::fs::write(
        format!("{}/rpc_request.json", work_dir),
        request.to_string()
    )?;

    // Read response
    let response = std::fs::read_to_string(
        format!("{}/rpc_response.json", work_dir)
    )?;

    let json: Value = serde_json::from_str(&response)?;

    json.get("result")
        .cloned()
        .ok_or("RPC error".to_string())
}
```

### Example: Reading Contract State

```rust
// eth_call to read contract data
let calldata = encode_function_call("getData", &[param1, param2]);

let result = rpc_call("eth_call", vec![
    json!({
        "to": contract_address,
        "data": calldata
    }),
    json!("latest")
])?;

let data = decode_response(&result)?;
```

---

## Workflow Integration

### Registering WASM Module

Before use, index the WASM module:

```typescript
import { keccak256, stringToBytes } from 'viem';

const wasmId = 'my-module-v1';
const wasmHash = keccak256(stringToBytes(wasmId)).slice(2);

// Index in MongoDB (executor setup)
```

### Workflow Definition

```typescript
import { WorkflowBuilder, JobBuilder } from '@ditto/workflow-sdk';

const workflow = WorkflowBuilder.create(ownerAccount)
  .addCronTrigger('0 */6 * * *')  // Every 6 hours
  .addJob(
    JobBuilder.create('my-job')
      .setChainId(1)

      // Step 1: WASM computation
      .addStep({
        type: 'wasm',
        target: '0x0000000000000000000000000000000000000000',
        abi: '',
        args: [],
        wasmHash: wasmHash,
        wasmId: wasmId,
        wasmInput: {
          action: 'my-action',
          param1: '0x...',
          param2: 123,
        },
        wasmTimeoutMs: 30000,
      })

      // Step 2: Execute with WASM output
      .addStep({
        target: CONTRACT_ADDRESS,
        abi: 'execute(uint256[])',
        args: ['$wasm:my-module-v1'],  // References WASM result.value
      })
      .build()
  )
  .build();
```

### WASM Reference Syntax

Use `$wasm:module-id` to reference WASM output:

```typescript
// Simple reference - uses result.value
args: ['$wasm:my-module-v1']

// Nested reference - uses result.value[0]
args: ['$wasm:my-module-v1[0]']
```

### Conditional Execution

WASM can skip remaining steps:

```json
{
  "ok": true,
  "result": {
    "success": true,
    "skipRemainingSteps": true,
    "message": "No action needed"
  }
}
```

---

## Testing

### Unit Tests

```bash
cargo test
```

### Local Testing with wasmtime

```bash
# Test with JSON input
cat test-input.json | wasmtime my-module.wasm

# Test with RPC (requires executor proxy)
export WASM_RPC_WORK_DIR=/tmp
echo '{"action":"my-action","param":"value"}' | wasmtime my-module.wasm
```

---

## Storing & Updating WASM Modules

### Flow

```
Build → Upload to IPFS → Submit to WasmRegistry
```

### 1. Generate WASM ID

```typescript
import { keccak256, stringToBytes } from 'viem';

const wasmName = 'my-module-v1';
const wasmId = keccak256(stringToBytes(wasmName)); // bytes32
```

### 2. Upload to IPFS

```bash
bun run upload-wasm.ts ./my-module.wasm my-module-v1
# Returns: ipfsHash (CID)
```

### 3. Submit to WasmRegistry

**Contract**: [`0x8AC137f8a44386e3ef131D50501910Ef076e284e`](https://basescan.org/address/0x8AC137f8a44386e3ef131D50501910Ef076e284e#writeContract) (Base)

| Function | Description |
|----------|-------------|
| `createWasm(bytes32 id, string ipfsHash)` | First-time submission |
| `updateWasm(bytes32 id, string newIpfsHash)` | Update existing |
| `wasmHash(bytes32 id)` | Query IPFS hash |

```bash
# Create
cast send 0x8AC137f8a44386e3ef131D50501910Ef076e284e \
  "createWasm(bytes32,string)" $WASM_ID $IPFS_HASH \
  --rpc-url https://mainnet.base.org --private-key $PK

# Update
cast send 0x8AC137f8a44386e3ef131D50501910Ef076e284e \
  "updateWasm(bytes32,string)" $WASM_ID $NEW_IPFS_HASH \
  --rpc-url https://mainnet.base.org --private-key $PK
```

