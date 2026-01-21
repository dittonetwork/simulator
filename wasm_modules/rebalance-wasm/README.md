# Yield Optimizer WASM Module

High-performance WASM module for optimizing YieldSplitVault allocations across multiple lending protocols.

## Overview

This WASM module implements the grid search optimization algorithm from `tmp/optimizer/` in Rust. It evaluates millions of allocation scenarios to find the optimal distribution of funds across protocols like Aave, Spark, Fluid, and MetaMorpho.

## Features

- **Grid Search Optimization**: Evaluates all weight combinations with configurable step size
- **Protocol Support**: Aave V3, Spark, Fluid V2, MetaMorpho
- **IRM Simulation**: Accurate interest rate model calculations
- **Constraint Handling**: TVL caps, blocked adapters, minimum allocations
- **Fast Execution**: Pure Rust implementation optimized for WASM

## Performance

- **~4.6M scenarios** evaluated with 1% step across 5 protocols
- **Typical execution**: 200-500ms (depending on constraints)
- **Output**: Optimal allocations as uint256[] for smart contract calls

## Build

```bash
# Install Rust toolchain if needed
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Build WASM module
./build.sh
```

This generates `yield-optimizer.wasm`.

## Input Format

The WASM module expects JSON input via stdin:

```json
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
    }
  ],
  "blockedMask": 0,
  "config": {
    "stepPct": 1,
    "maxPoolShare": 0.2,
    "minAllocation": 1000
  }
}
```

### Protocol Types

- `1` = Aave V3
- `2` = Spark
- `3` = Fluid V2
- `4` = MetaMorpho

### Blocked Mask

Bitmask indicating blocked protocols (from GuardManager):
- Bit 0 = Protocol 0
- Bit 1 = Protocol 1
- etc.

## Output Format

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "success": true,
    "allocations": [
      "0x00000000000000000000000000000000000000000000000000000000001e8480",
      "0x00000000000000000000000000000000000000000000000000000000001e8480"
    ],
    "allocationsDecimal": [2000000, 2000000],
    "weights": [0.2, 0.2, 0.2, 0.2, 0.2],
    "expectedReturn12h": 1234.56,
    "expectedApyWeighted": 0.045,
    "apys": [0.04, 0.035, 0.08, 0.06, 0.055],
    "scenariosEvaluated": 4598126,
    "timeMs": 234.5
  }
}
```

## Workflow Integration

The TypeScript workflow script (`create-workflow.ts`) demonstrates how to:

1. Execute the WASM optimizer with protocol data
2. Pass the optimization results to a rebalance contract
3. Handle the workflow submission to the Ditto network

```bash
# Install dependencies
npm install  # or bun install

# Create workflow
npm run create-workflow  # or bun run create-workflow.ts
```

## Testing Locally

You can test the WASM module locally using wasmtime:

```bash
# Install wasmtime
curl https://wasmtime.dev/install.sh -sSf | bash

# Run with test input
echo '{"totalAssets":10000000,"protocols":[...],"blockedMask":0}' | \
  wasmtime yield-optimizer.wasm
```

## Algorithm

1. **Grid Generation**: Generate all weight combinations summing to 100%
   - Uses stars-and-bars combinatorics
   - Optionally bounded by TVL constraints for faster execution

2. **Constraint Filtering**: Remove invalid allocations
   - Blocked adapter deposits (from GuardManager)
   - TVL cap violations (>20% of pool)
   - Below minimum allocation threshold

3. **IRM Simulation**: Calculate APYs for each protocol
   - **Aave/Spark**: Single-kink IRM
   - **Fluid**: Double-kink IRM
   - **MetaMorpho**: Dilution model

4. **Return Calculation**: Expected 12h return = Σ(allocation × APY × 12/8760)

5. **Optimization**: Select allocation with maximum expected return

## Architecture

```
tmp/rebalance-wasm/
├── src/
│   └── lib.rs           # Main WASM implementation
├── Cargo.toml           # Rust dependencies
├── build.sh             # Build script
├── create-workflow.ts   # Workflow creation
├── package.json         # TypeScript dependencies
├── test-input.json      # Sample input for testing
└── README.md           # This file
```

## Production Considerations

### Data Source

In production, protocol data should be fetched via:
- **VaultDataReader** helper contract (see `tmp/yield-split/helpers/VaultDataReader.sol`)
- Single RPC call to `getSnapshot()` returns all protocol state
- Can be called from TypeScript or from within WASM via RPC proxy

### WASM Indexing

Before workflow execution, the WASM module must be indexed in MongoDB:

```bash
# Generate MongoDB document
bun run index-wasm.ts
```

### Gas Optimization

The rebalance contract call may be expensive if many protocols need rebalancing. Consider:
- Setting higher `minAllocation` to avoid dust positions
- Using larger `stepPct` (e.g., 5%) to reduce computation time
- Implementing on-chain delta encoding to only update changed allocations

## Comparison with Python

This Rust/WASM implementation provides:
- ✅ **Portable**: Runs in WASM runtime (browser, Node, Ditto network)
- ✅ **Deterministic**: Same input always produces same output
- ✅ **Self-contained**: No external dependencies or Python runtime needed
- ⚠️ **Performance**: Slightly slower than Python+Numba (no SIMD/parallelization in WASM)
- ⚠️ **Development**: Rust has steeper learning curve than Python

For off-chain optimization where Python is available, use `tmp/optimizer/`. For on-chain automation via Ditto workflows, use this WASM module.

## License

MIT
