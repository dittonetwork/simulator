# WASM Workflow Integration

This document describes the WASM step support added to workflows, enabling execution of WASM code with onchain RPC calls and result propagation to subsequent contract steps.

## Overview

WASM steps allow workflows to:
1. Execute WASM code that can make read-only RPC calls to blockchain networks
2. Use WASM execution results in subsequent contract call steps
3. Maintain the same workflow interface as existing fetch-and-propagate features

## Architecture

### Components Added

1. **WasmRefResolver** (`ditto-workflow-sdk/src/core/WasmRefResolver.ts`)
   - Executes WASM steps before contract steps
   - Resolves WASM references (`$wasm:{wasmId}`) in step arguments
   - Stores results for deterministic replay (operator mode)

2. **Extended Step Type** (`ditto-workflow-sdk/src/core/types.ts`)
   - Added `type?: 'contract' | 'wasm'` field
   - Added WASM-specific fields: `wasmB64`, `wasmHash`, `wasmInput`, `wasmId`, `wasmTimeoutMs`

3. **WorkflowExecutor Integration** (`ditto-workflow-sdk/src/core/execution/WorkflowExecutor.ts`)
   - Executes WASM steps first
   - Resolves WASM references in contract step arguments
   - Passes WASM client and context through execution chain

## Usage

### Creating a WASM Step

```typescript
import { Step } from '@ditto/workflow-sdk';

// WASM step that makes RPC calls and returns results
// Note: Only wasmHash is required - WASM bytes are retrieved from MongoDB by hash
const wasmStep = new Step({
  type: 'wasm',
  target: '0x0000000000000000000000000000000000000000', // Not used for WASM steps
  abi: '', // Not used for WASM steps
  args: [], // Not used for WASM steps
  wasmHash: 'sha256hash...', // Required: SHA256 hash (IPFS hash) - WASM bytes stored in MongoDB
  wasmId: 'my-wasm-step-1', // Required: unique identifier for result referencing
  wasmInput: {
    // Input JSON for WASM execution
    chainId: 1,
    address: '0x...',
  },
  wasmTimeoutMs: 2000, // Optional, default: 2000ms
});
```

### Referencing WASM Results in Contract Steps

```typescript
// Contract step that uses WASM result
const contractStep = new Step({
  target: '0xContractAddress',
  abi: 'transfer(address,uint256)',
  args: [
    '0xRecipientAddress',
    '$wasm:my-wasm-step-1', // Reference WASM result
  ],
});
```

### Complete Workflow Example

```typescript
import { Workflow, Job, Step } from '@ditto/workflow-sdk';

const workflow = new Workflow({
  owner: '0x...',
  jobs: [
    new Job({
      id: 'job1',
      chainId: 1,
      steps: [
        // Step 1: Execute WASM code that fetches data via RPC
        // Note: wasmHash is the IPFS hash - indexer will fetch WASM bytes and store in MongoDB
        new Step({
          type: 'wasm',
          target: '0x0000000000000000000000000000000000000000',
          abi: '',
          args: [],
          wasmHash: 'QmXxx...', // IPFS hash (SHA256) - WASM bytes retrieved from MongoDB
          wasmId: 'fetch-balance',
          wasmInput: {
            address: '0x...',
            chainId: 1,
          },
        }),
        // Step 2: Use WASM result in contract call
        new Step({
          target: '0xTokenContract',
          abi: 'transfer(address,uint256)',
          args: [
            '0xRecipient',
            '$wasm:fetch-balance', // WASM result used here
          ],
        }),
      ],
    }),
  ],
});
```

## WASM Module Requirements

WASM modules must:
1. Export a `run()` function (called by the host)
2. Read input from stdin (JSON)
3. Output result to stdout (JSON)
4. Can call `host_rpc()` helper function for RPC calls (via file-based protocol)

### Example WASM Module (Rust)

```rust
use serde_json::{json, Value};

#[no_mangle]
pub extern "C" fn run() {
    // Read input from stdin
    let mut input_str = String::new();
    std::io::stdin().read_line(&mut input_str).unwrap();
    let input: Value = serde_json::from_str(&input_str).unwrap();
    
    // Make RPC call via host bridge
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_getBalance",
        "params": [input["address"], "latest"]
    });
    
    let balance = match host_rpc(&request.to_string()) {
        Ok(response) => {
            // Parse response and extract balance
            // ...
        }
        Err(e) => {
            eprintln!("RPC call failed: {}", e);
            return;
        }
    };
    
    // Output result to stdout
    let output = json!({
        "balance": balance,
        "processed": true
    });
    println!("{}", output.to_string());
}
```

## Execution Flow

1. **WASM Module Lookup**
   - When a WASM step is encountered, the system looks up WASM bytes from MongoDB by `wasmHash`
   - If WASM module not found, execution fails with error suggesting indexer needs to fetch it
   - Indexer app should fetch WASM from IPFS (using hash) and store in MongoDB

2. **WASM Step Execution**
   - WASM steps are executed first (before contract steps)
   - WASM bytes are retrieved from MongoDB using the hash
   - Each WASM step runs in isolation with its own work directory
   - RPC calls are processed via the host bridge (file-based protocol)
   - Results are stored in `WasmRefContext`

2. **Result Resolution**
   - Contract steps can reference WASM results using `$wasm:{wasmId}`
   - WASM references are resolved before DataRef resolution
   - Resolved values are passed to contract call arguments

3. **Contract Step Execution**
   - Contract steps execute normally with resolved arguments
   - Can combine WASM results with DataRef results

## Deterministic Consensus

Similar to DataRef, WASM execution supports deterministic consensus:
- Leader creates `WasmRefContext` during simulation
- Context is serialized and passed to operators
- Operators use context to skip WASM execution (use cached results)
- Ensures all operators get identical results

## Integration Points

### WorkflowSDK Integration

The integration layer (`src/integrations/workflowSDK.ts`) automatically:
- Creates WASM client if available
- Passes WASM client to execution functions
- Handles WASM context serialization

### WASM Client

The WASM client (`src/utils/wasmClient.ts`) supports:
- External WASM server (via `WASM_SERVER_URL`)
- Integrated WASM server (same Express app at `/wasm/*`)
- Health checks and error handling

## WASM Storage in MongoDB

WASM modules are stored in MongoDB collection `wasm_modules` with the following schema:

```typescript
{
  hash: string;        // SHA256/IPFS hash (indexed)
  bytes: Buffer;       // WASM module bytes
  storedAt: Date;      // Timestamp when stored
}
```

### Indexer App Requirements

An indexer app should:
1. Monitor IPFS for new WASM modules (or listen to workflow creation events)
2. Fetch WASM bytes from IPFS using the hash
3. Store WASM bytes in MongoDB using `Database.storeWasmModule(wasmHash, wasmBytes)`
4. Ensure WASM modules are available before workflows execute

Example indexer code:
```typescript
import { Database } from './db.js';
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

## Limitations

1. **Read-Only RPC**: WASM modules can only make read-only RPC calls (via RpcSimulator)
2. **File-Based Protocol**: Current implementation uses file-based RPC bridge (workaround for Wasmtime JS API limitations)
3. **Timeout**: Default 2s timeout per WASM execution (configurable)
4. **Size Limits**: WASM modules limited to 10MB, outputs limited to 256KB
5. **MongoDB Dependency**: WASM modules must be indexed in MongoDB before workflow execution

## Future Enhancements

1. Proper Wasmtime host imports (when JS API supports it)
2. WASM result caching based on input hash
3. Support for multiple WASM results per step
4. WASM step dependencies (one WASM step can reference another)
