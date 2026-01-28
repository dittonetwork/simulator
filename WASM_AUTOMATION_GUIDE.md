# Complete Guide: Creating WASM Automation Workflows

This guide walks you through creating a complete WASM-based automation workflow from scratch.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Step 1: Create a WASM Module](#step-1-create-a-wasm-module)
3. [Step 2: Build the WASM Module](#step-2-build-the-wasm-module)
4. [Step 3: Test Your WASM Module](#step-3-test-your-wasm-module)
5. [Step 4: Upload WASM to IPFS](#step-4-upload-wasm-to-ipfs)
6. [Step 5: Create a Workflow with WASM Steps](#step-5-create-a-workflow-with-wasm-steps)
7. [Step 6: Deploy and Execute](#step-6-deploy-and-execute)
8. [Common Patterns](#common-patterns)

---

## Prerequisites

- Rust installed (for building WASM modules)
- Node.js/Bun installed
- Access to IPFS service
- MongoDB running (for WASM module storage)
- WASM server running (or integrated in simulator)

---

## Step 1: Create a WASM Module

### 1.1 Create a New Rust Project

```bash
cd examples/wasm
cargo new --lib my-automation
cd my-automation
```

### 1.2 Configure Cargo.toml

Edit `Cargo.toml`:

```toml
[package]
name = "my-automation"
version = "0.1.0"
edition = "2021"
autobins = false

[lib]
name = "my_automation"
crate-type = ["cdylib"]
path = "src/lib.rs"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
```

### 1.3 Write Your WASM Module

Create `src/lib.rs`:

```rust
use std::alloc::{alloc as std_alloc, dealloc as std_dealloc, Layout};
use serde_json::{json, Value};

/// Allocate memory (required export)
#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let layout = Layout::from_size_align(len as usize, 1).unwrap();
    unsafe { std_alloc(layout) }
}

/// Deallocate memory (required export)
#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: u32) {
    if !ptr.is_null() {
        let layout = Layout::from_size_align(len as usize, 1).unwrap();
        unsafe { std_dealloc(ptr, layout) };
    }
}

/// Host RPC helper function
/// Uses file-based protocol to communicate with host
fn host_rpc(req: &str) -> Result<String, String> {
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    
    let work_dir = env::var("WASM_RPC_WORK_DIR")
        .map_err(|_| "WASM_RPC_WORK_DIR not set")?;
    let request_file = env::var("WASM_RPC_REQUEST_FILE")
        .unwrap_or_else(|_| "wasm_rpc_request.json".to_string());
    let response_file = env::var("WASM_RPC_RESPONSE_FILE")
        .unwrap_or_else(|_| "wasm_rpc_response.json".to_string());
    
    let request_path = PathBuf::from(&work_dir).join(&request_file);
    let response_path = PathBuf::from(&work_dir).join(&response_file);
    
    // Write request
    fs::write(&request_path, req)
        .map_err(|e| format!("Failed to write request: {}", e))?;
    
    // Poll for response (with timeout)
    let max_iterations = 500; // 5 seconds max
    for _ in 0..max_iterations {
        if response_path.exists() {
            let response = fs::read_to_string(&response_path)
                .map_err(|e| format!("Failed to read response: {}", e))?;
            
            // Clean up
            let _ = fs::remove_file(&request_path);
            let _ = fs::remove_file(&response_path);
            
            return Ok(response);
        }
        
        // Spin wait (10ms equivalent)
        for _ in 0..1000 {}
    }
    
    Err("RPC call timeout".to_string())
}

/// Main entry point (required export)
#[no_mangle]
pub extern "C" fn run() {
    use std::io::{self, BufRead};
    
    // Read input from stdin
    let stdin = io::stdin();
    let input_line = stdin.lock().lines().next()
        .unwrap_or_else(|| Ok("{}".to_string()))
        .unwrap_or_else(|_| "{}".to_string());
    
    let input: Value = serde_json::from_str(&input_line)
        .unwrap_or_else(|_| json!({}));
    
    // Extract parameters from input
    let address = input.get("address")
        .and_then(|v| v.as_str())
        .unwrap_or("0x0000000000000000000000000000000000000000");
    let chain_id = input.get("chainId")
        .and_then(|v| v.as_u64())
        .unwrap_or(1);
    
    // Example: Fetch balance via RPC
    let balance_request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_getBalance",
        "params": [address, "latest"]
    });
    
    let balance_result = match host_rpc(&balance_request.to_string()) {
        Ok(response_str) => {
            match serde_json::from_str::<Value>(&response_str) {
                Ok(response) => {
                    // Extract balance from response
                    let balance_hex = response
                        .get("result")
                        .and_then(|v| v.as_str())
                        .unwrap_or("0x0");
                    
                    // Convert hex to decimal (optional)
                    let balance_decimal = u128::from_str_radix(
                        balance_hex.strip_prefix("0x").unwrap_or(balance_hex),
                        16
                    ).unwrap_or(0);
                    
                    json!({
                        "success": true,
                        "balance": balance_hex,
                        "balanceDecimal": balance_decimal.to_string(),
                        "address": address,
                        "chainId": chain_id
                    })
                }
                Err(e) => json!({
                    "success": false,
                    "error": format!("Failed to parse response: {}", e)
                })
            }
        }
        Err(e) => json!({
            "success": false,
            "error": e
        })
    };
    
    // Output result to stdout (must be JSON)
    let output = json!({
        "ok": true,
        "result": balance_result
    });
    
    println!("{}", output.to_string());
}
```

### 1.4 Example: More Complex Automation

Here's an example that fetches multiple pieces of data and performs calculations:

```rust
#[no_mangle]
pub extern "C" fn run() {
    use std::io::{self, BufRead};
    use serde_json::{json, Value};
    
    // Read input
    let stdin = io::stdin();
    let input_line = stdin.lock().lines().next()
        .unwrap_or_else(|| Ok("{}".to_string()))
        .unwrap_or_else(|_| "{}".to_string());
    
    let input: Value = serde_json::from_str(&input_line).unwrap_or(json!({}));
    let address = input.get("address").and_then(|v| v.as_str()).unwrap_or("0x0");
    
    let mut results = Vec::new();
    
    // 1. Get balance
    let balance_req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_getBalance",
        "params": [address, "latest"]
    });
    
    if let Ok(response_str) = host_rpc(&balance_req.to_string()) {
        if let Ok(response) = serde_json::from_str::<Value>(&response_str) {
            results.push(json!({
                "type": "balance",
                "value": response.get("result")
            }));
        }
    }
    
    // 2. Get transaction count (nonce)
    let nonce_req = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "eth_getTransactionCount",
        "params": [address, "latest"]
    });
    
    if let Ok(response_str) = host_rpc(&nonce_req.to_string()) {
        if let Ok(response) = serde_json::from_str::<Value>(&response_str) {
            results.push(json!({
                "type": "nonce",
                "value": response.get("result")
            }));
        }
    }
    
    // 3. Call a contract (read-only)
    let contract_address = input.get("contractAddress").and_then(|v| v.as_str());
    if let Some(contract) = contract_address {
        let call_req = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "eth_call",
            "params": [{
                "to": contract,
                "data": "0x70a08231" // balanceOf(address) selector
            }, "latest"]
        });
        
        if let Ok(response_str) = host_rpc(&call_req.to_string()) {
            if let Ok(response) = serde_json::from_str::<Value>(&response_str) {
                results.push(json!({
                    "type": "contractCall",
                    "value": response.get("result")
                }));
            }
        }
    }
    
    // Output combined results
    let output = json!({
        "ok": true,
        "result": {
            "address": address,
            "data": results,
            "count": results.len()
        }
    });
    
    println!("{}", output.to_string());
}
```

---

## Step 2: Build the WASM Module

### 2.1 Install WASM Target

```bash
rustup target add wasm32-wasip1
```

### 2.2 Build for Release

```bash
cargo build --target wasm32-wasip1 --release
```

### 2.3 Copy Output

```bash
# The output will be at:
# target/wasm32-wasip1/release/my_automation.wasm

# Copy to a convenient location
cp target/wasm32-wasip1/release/my_automation.wasm ../my-automation.wasm
```

### 2.4 Create Build Script (Optional)

Create `build.sh`:

```bash
#!/bin/bash
set -e

echo "Building WASM module..."

cargo build --target wasm32-wasip1 --release

cp target/wasm32-wasip1/release/my_automation.wasm ../my-automation.wasm

echo "Build complete: ../my-automation.wasm"
```

Make it executable:

```bash
chmod +x build.sh
./build.sh
```

---

## Step 3: Test Your WASM Module

### 3.1 Test Locally

Use the provided test script:

```bash
# Make sure WASM server is running (or simulator with WASM support)
bun run examples/wasm/run-wasm.ts \
  --wasm examples/wasm/my-automation.wasm \
  --input '{"address": "0x0000000000000000000000000000000000000000", "chainId": 1}' \
  --timeout 5000
```

### 3.2 Test via HTTP API

```bash
# Base64 encode your WASM file
WASM_B64=$(base64 -i examples/wasm/my-automation.wasm)

# Call the WASM server
curl -X POST http://localhost:8080/wasm/run \
  -H "Content-Type: application/json" \
  -d "{
    \"jobId\": \"test-$(date +%s)\",
    \"wasmB64\": \"$WASM_B64\",
    \"timeoutMs\": 5000,
    \"input\": {
      \"address\": \"0x0000000000000000000000000000000000000000\",
      \"chainId\": 1
    }
  }"
```

### 3.3 Expected Output Format

Your WASM module should output JSON to stdout:

```json
{
  "ok": true,
  "result": {
    "success": true,
    "balance": "0x1234...",
    "address": "0x...",
    "chainId": 1
  }
}
```

Or on error:

```json
{
  "ok": false,
  "error": "Error message here"
}
```

---

## Step 4: Upload WASM to IPFS

### 4.1 Calculate SHA256 Hash

```bash
# Calculate hash (this will be your wasmHash)
sha256sum examples/wasm/my-automation.wasm
# or
shasum -a 256 examples/wasm/my-automation.wasm
```

### 4.2 Upload to IPFS

You can use the IPFS storage from the SDK:

```typescript
import { IpfsStorage } from '@ditto/workflow-sdk';
import fs from 'fs';

async function uploadWasm() {
  const storage = new IpfsStorage('https://your-ipfs-service.com');
  
  const wasmBytes = fs.readFileSync('examples/wasm/my-automation.wasm');
  const hash = await storage.upload(wasmBytes);
  
  console.log('WASM uploaded to IPFS:', hash);
  console.log('Use this hash as wasmHash in your workflow steps');
  
  return hash;
}
```

### 4.3 Store in MongoDB (Indexer)

The indexer should fetch WASM from IPFS and store it in MongoDB:

```typescript
import { Database } from './db';
import { IpfsStorage } from '@ditto/workflow-sdk';

async function indexWasmModule(wasmHash: string) {
  const db = new Database();
  await db.connect();
  
  // Check if already indexed
  if (await db.hasWasmModule(wasmHash)) {
    console.log(`WASM module ${wasmHash} already indexed`);
    return;
  }
  
  // Fetch from IPFS
  const storage = new IpfsStorage(ipfsServiceUrl);
  const wasmBytes = await storage.download(wasmHash);
  
  // Store in MongoDB
  await db.storeWasmModule(wasmHash, Buffer.from(wasmBytes));
  console.log(`Indexed WASM module ${wasmHash}`);
}
```

---

## Step 5: Create a Workflow with WASM Steps

### 5.1 Basic Workflow with WASM Step

```typescript
import { Workflow, Job, Step } from '@ditto/workflow-sdk';

const workflow = new Workflow({
  owner: '0xYourOwnerAddress',
  jobs: [
    new Job({
      id: 'my-automation-job',
      chainId: 1, // Ethereum mainnet
      steps: [
        // Step 1: Execute WASM to fetch balance
        new Step({
          type: 'wasm',
          target: '0x0000000000000000000000000000000000000000', // Not used
          abi: '', // Not used
          args: [], // Not used
          wasmHash: 'your-sha256-hash-here', // From Step 4
          wasmId: 'fetch-balance', // Unique ID for referencing
          wasmInput: {
            address: '0xYourAddress',
            chainId: 1,
          },
          wasmTimeoutMs: 5000,
        }),
        // Step 2: Use WASM result in contract call
        new Step({
          target: '0xTokenContractAddress',
          abi: 'transfer(address,uint256)',
          args: [
            '0xRecipientAddress',
            '$wasm:fetch-balance', // Reference WASM result
          ],
        }),
      ],
    }),
  ],
});
```

### 5.2 Using WorkflowBuilder

```typescript
import { WorkflowBuilder, JobBuilder } from '@ditto/workflow-sdk';

const workflow = WorkflowBuilder.create('0xYourOwnerAddress')
  .addCronTrigger('0 */6 * * *') // Every 6 hours
  .setCount(10) // Execute 10 times
  .setValidAfter(Date.now())
  .setValidUntil(Date.now() + 1000 * 60 * 60 * 24 * 30) // 30 days
  .addJob(
    JobBuilder.create('automation-job-1')
      .setChainId(1)
      .addStep({
        type: 'wasm',
        target: '0x0000000000000000000000000000000000000000',
        abi: '',
        args: [],
        wasmHash: 'your-wasm-hash',
        wasmId: 'check-conditions',
        wasmInput: {
          address: '0x...',
          contractAddress: '0x...',
        },
      })
      .addStep({
        target: '0xContractAddress',
        abi: 'executeAction(uint256)',
        args: ['$wasm:check-conditions'], // Use WASM result
      })
      .build()
  )
  .build();
```

### 5.3 Complex Workflow Example

```typescript
const workflow = new Workflow({
  owner: '0x...',
  jobs: [
    new Job({
      id: 'multi-step-automation',
      chainId: 1,
      steps: [
        // WASM Step 1: Fetch account data
        new Step({
          type: 'wasm',
          target: '0x0000000000000000000000000000000000000000',
          abi: '',
          args: [],
          wasmHash: 'hash-for-data-fetcher',
          wasmId: 'account-data',
          wasmInput: { address: '0x...' },
        }),
        // WASM Step 2: Calculate values
        new Step({
          type: 'wasm',
          target: '0x0000000000000000000000000000000000000000',
          abi: '',
          args: [],
          wasmHash: 'hash-for-calculator',
          wasmId: 'calculated-values',
          wasmInput: {
            // Can reference previous WASM result
            previousData: '$wasm:account-data',
          },
        }),
        // Contract Step: Use calculated values
        new Step({
          target: '0xContract',
          abi: 'process(uint256,uint256)',
          args: [
            '$wasm:account-data', // First WASM result
            '$wasm:calculated-values', // Second WASM result
          ],
        }),
      ],
    }),
  ],
});
```

---

## Step 6: Deploy and Execute

### 6.1 Submit Workflow

```typescript
import { submitWorkflow } from '@ditto/workflow-sdk';
import { IpfsStorage } from '@ditto/workflow-sdk';
import { privateKeyToAccount } from 'viem/accounts';

async function deployWorkflow() {
  const storage = new IpfsStorage('https://your-ipfs-service.com');
  const ownerAccount = privateKeyToAccount('0xYourPrivateKey');
  const executorAddress = '0xExecutorAddress';
  
  const response = await submitWorkflow(
    workflow,
    executorAddress,
    storage,
    ownerAccount,
    false, // prodContract
    'https://your-ipfs-service.com'
  );
  
  console.log('Workflow submitted:', response);
  return response;
}
```

### 6.2 Monitor Execution

The workflow will execute automatically based on its trigger (cron, onchain event, etc.). The WASM steps will:

1. Look up WASM bytes from MongoDB using `wasmHash`
2. Execute WASM with provided `wasmInput`
3. Store results with the `wasmId`
4. Resolve `$wasm:{wasmId}` references in subsequent steps

---

## Common Patterns

### Pattern 1: Balance Check Before Transfer

```typescript
// WASM step checks if balance is sufficient
new Step({
  type: 'wasm',
  wasmHash: 'balance-checker-hash',
  wasmId: 'balance-check',
  wasmInput: {
    address: '0x...',
    minBalance: '1000000000000000000', // 1 ETH
  },
}),
// Contract step only executes if balance is sufficient
new Step({
  target: '0xToken',
  abi: 'transfer(address,uint256)',
  args: ['0xRecipient', '$wasm:balance-check'],
}),
```

### Pattern 2: Multi-Chain Data Aggregation

```typescript
// WASM fetches data from multiple chains via RPC
new Step({
  type: 'wasm',
  wasmHash: 'multi-chain-aggregator',
  wasmId: 'aggregated-data',
  wasmInput: {
    addresses: ['0x...', '0x...'],
    chainIds: [1, 137, 42161], // Ethereum, Polygon, Arbitrum
  },
}),
```

### Pattern 3: Conditional Execution

```typescript
// WASM evaluates conditions and returns decision
new Step({
  type: 'wasm',
  wasmHash: 'condition-evaluator',
  wasmId: 'should-execute',
  wasmInput: {
    conditions: { /* ... */ },
  },
}),
// Contract step uses WASM result to decide action
new Step({
  target: '0xContract',
  abi: 'conditionalAction(uint256)',
  args: ['$wasm:should-execute'],
}),
```

### Pattern 4: Data Transformation

```typescript
// WASM fetches raw data and transforms it
new Step({
  type: 'wasm',
  wasmHash: 'data-transformer',
  wasmId: 'transformed-data',
  wasmInput: {
    rawData: '$data:some-data-ref', // Can combine with DataRef
  },
}),
```

---

## Troubleshooting

### WASM Module Not Found

**Error:** `WASM module not found in database: {hash}`

**Solution:** Ensure the indexer has fetched and stored the WASM module:
```typescript
await db.storeWasmModule(wasmHash, wasmBytes);
```

### RPC Call Timeout

**Error:** `RPC call timeout`

**Solution:** 
- Check RPC URL is configured correctly
- Increase timeout in WASM module polling
- Verify network connectivity

### Invalid Output Format

**Error:** `Failed to parse WASM output`

**Solution:** Ensure your WASM module outputs valid JSON to stdout:
```rust
let output = json!({
    "ok": true,
    "result": { /* your data */ }
});
println!("{}", output.to_string());
```

### WASM Reference Not Found

**Error:** `WASM reference not found: {wasmId}`

**Solution:** 
- Ensure WASM step executed before contract step
- Check `wasmId` matches exactly (case-sensitive)
- Verify WASM step completed successfully

---

## Best Practices

1. **Idempotency**: Design WASM modules to be idempotent - same input should produce same output
2. **Error Handling**: Always handle RPC errors gracefully
3. **Timeout Management**: Set appropriate timeouts for RPC calls
4. **Output Validation**: Validate and structure your output JSON clearly
5. **Testing**: Test WASM modules independently before integrating into workflows
6. **Logging**: Use `eprintln!` for debug logs (they go to stderr)
7. **Resource Limits**: Keep WASM modules small and efficient
8. **Documentation**: Document expected input/output formats

---

## Next Steps

- Explore more complex RPC patterns
- Combine multiple WASM steps in workflows
- Use WASM results with DataRef results
- Implement custom validation logic
- Build reusable WASM modules library

---

## Additional Resources

- [WASM Workflow Integration](./WASM_WORKFLOW_INTEGRATION.md) - Detailed technical documentation
- [WASM System Specification](./examples/wasm/README.md) - System architecture details
- [Rust RPC Example](./examples/wasm/rpc-example/) - Complete working example
