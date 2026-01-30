# Yield Optimizer WASM Module

WASM module for YieldSplitVault automation - optimizes allocations across lending protocols to maximize yield.

> For general WASM module concepts (architecture, RPC, workflow integration), see the [parent documentation](../README.md).

## Quick Start

```bash
# Build
./build.sh

# Test
cargo test

# Local run (requires wasmtime)
cat test-input.json | wasmtime yield-optimizer.wasm
```

Output: `yield-optimizer.wasm` (~275KB)

---

## Algorithm

### Optimization Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│                    OPTIMIZATION PIPELINE                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. FETCH DATA                                              │
│     └─▶ VaultDataReader.getSnapshot()                       │
│         - Total assets, protocol balances                   │
│         - Pool supply/borrow, utilization                   │
│         - IRM parameters, guard state                       │
│                                                             │
│  2. GENERATE WEIGHT GRID                                    │
│     └─▶ Stars-and-bars combinatorics                        │
│         - All combinations summing to 100%                  │
│         - Bounded by constraints (faster)                   │
│         - Step size: 1% (configurable)                      │
│                                                             │
│  3. FILTER BY CONSTRAINTS                                   │
│     └─▶ For each combination:                               │
│         - Max pool share (20% of protocol TVL)              │
│         - Max vault allocation (40% per protocol)           │
│         - Min allocation ($1000)                            │
│         - Blocked protocol check                            │
│                                                             │
│  4. CALCULATE APY                                           │
│     └─▶ Interest Rate Model simulation                      │
│         - New utilization after rebalance                   │
│         - Protocol-specific IRM curves                      │
│         - Supply APY = borrow_rate × utilization × (1-RF)   │
│                                                             │
│  5. SELECT OPTIMAL                                          │
│     └─▶ Maximize expected 12-hour return                    │
│         - return = Σ(allocation × APY × 12/8760)            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Grid Generation

Uses "stars and bars" combinatorics to generate all possible weight distributions:

```
5 protocols, 1% step → ~4.6M combinations
5 protocols, 5% step → ~10K combinations

With bounded constraints → typically 90%+ reduction
```

**Bounded grid optimization:**

```rust
// Calculate max weight per protocol based on constraints
let max_weights: Vec<usize> = protocols.iter().enumerate().map(|(i, p)| {
    let pool_cap = (p.pool_supply * max_pool_share / total_assets * 100.0) as usize;
    let vault_cap = (max_vault_allocation_share * 100.0) as usize;

    if is_blocked(i) {
        (p.our_balance / total_assets * 100.0) as usize
    } else {
        pool_cap.min(vault_cap)
    }
}).collect();

// Generate only valid combinations
generate_bounded_weight_grid(n_protocols, step_pct, &max_weights)
```

### Interest Rate Models

Each protocol has a different IRM curve:

```
           Supply APY
               │
          0.25 ┤                              ╱ Fluid
               │                           ╱
          0.20 ┤                        ╱
               │                     ╱
          0.15 ┤                  ╱
               │               ╱
          0.10 ┤            ╱─────────── Aave/Spark
               │         ╱
          0.05 ┤      ╱
               │   ╱
          0.00 ┼──┴───────────────────────────────▶
               0%   50%   80%  90%  95%  100%
                        Utilization
```

**Double-kink formula:**

```rust
fn calc_borrow_rate(util: f64, irm: &IRMParams) -> f64 {
    if util <= irm.kink1 {
        util / irm.kink1 * irm.rate_at_kink1
    } else if util <= irm.kink2 {
        let progress = (util - irm.kink1) / (irm.kink2 - irm.kink1);
        irm.rate_at_kink1 + progress * (irm.rate_at_kink2 - irm.rate_at_kink1)
    } else {
        let progress = (util - irm.kink2) / (1.0 - irm.kink2);
        irm.rate_at_kink2 + progress * (irm.rate_at_max - irm.rate_at_kink2)
    }
}

fn calc_supply_apy(util: f64, irm: &IRMParams) -> f64 {
    calc_borrow_rate(util, irm) * util * (1.0 - irm.reserve_factor)
}
```

### MetaMorpho Special Case

MetaMorpho vaults use dilution-based APY:

```rust
fn calc_morpho_apy(protocol: &ProtocolState, allocation: f64) -> f64 {
    let our_delta = allocation - protocol.our_balance;
    let new_total_supply = protocol.meta_total_supply + our_delta;
    let dilution_factor = protocol.our_balance / new_total_supply;
    protocol.current_apy * dilution_factor
}
```

---

## Configuration

### Optimizer Config

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `stepPct` | int | 1 | Grid step size (1 = 1%) |
| `maxPoolShare` | float | 0.2 | Max share of protocol's TVL (20%) |
| `minAllocation` | float | 1000 | Minimum non-zero allocation ($) |
| `maxVaultAllocationShare` | float | 0.4 | Max share of vault per protocol (40%) |

### Constraints

| Constraint | Formula | Purpose |
|------------|---------|---------|
| **Pool Share** | `alloc ≤ (pool_supply + delta) × maxPoolShare` | Prevent concentration in small pools |
| **Vault Allocation** | `alloc ≤ total_assets × maxVaultAllocationShare` | Diversification across protocols |
| **Min Allocation** | `alloc = 0 OR alloc ≥ minAllocation` | Prevent dust positions |
| **Blocked Protocol** | `alloc ≤ current_balance` if blocked | Respect guard restrictions |

### Protocol Types

| Type | Protocol | IRM |
|------|----------|-----|
| 1 | Aave V3 | Double-kink |
| 2 | Spark | Double-kink |
| 3 | Fluid V2 | Double-kink (steep) |
| 4 | MetaMorpho | Dilution-based |

---

## Input Format

### RPC Mode (Production)

```json
{
  "action": "rebalance",
  "vaultDataReader": "0xb228c97Ef7c67f2ad49Fe8645e3d7E7b5C5897aa",
  "vault": "0x62507A876309639096D08E7F77AC9CfB67Df8011",
  "protocolTypes": [1, 3, 4, 4, 2],
  "pools": [
    "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    "0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33",
    "0xdd0f28e19C1780eb6396170735D45153D261490d",
    "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB",
    "0xC13e21B648A5Ee794902342038FF3aDAB66BE987"
  ],
  "chainId": 1,
  "config": {
    "stepPct": 1,
    "maxPoolShare": 0.2,
    "minAllocation": 1000,
    "maxVaultAllocationShare": 0.4
  }
}
```

### Legacy Mode (Testing)

```json
{
  "action": "rebalance",
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
    "minAllocation": 1000,
    "maxVaultAllocationShare": 0.4
  }
}
```

---

## Output Format

### Successful Optimization

```json
{
  "ok": true,
  "result": {
    "success": true,
    "value": [
      "0x058d15e176280000",
      "0x06f05b59d3b20000",
      "0x0429d069189e0000",
      "0x0429d069189e0000",
      "0x0429d069189e0000"
    ],
    "weights": ["0x058d15e176280000", "..."],
    "weightsDecimal": [0.4, 0.5, 0.03, 0.03, 0.04],
    "allocations": ["0x...", "..."],
    "allocationsDecimal": [4000000, 5000000, 300000, 300000, 400000],
    "expectedReturn12h": 2465.75,
    "expectedApyWeighted": 0.0432,
    "apys": [0.041, 0.038, 0.052, 0.048, 0.045],
    "scenariosEvaluated": 15246,
    "timeMs": 45.2
  }
}
```

The `value` field contains weights in WAD format (1e18 scale) for `executeRebalance(uint256[])`.

---

## Testing

### Unit Tests

```bash
cargo test
```

Tests:
- `test_max_vault_allocation_share_constraint` - 40% limit validation
- `test_max_vault_allocation_share_with_different_limits` - Various limits
- `test_pool_share_constraint_still_works` - 20% pool cap
- `test_optimizer_respects_vault_allocation_limit` - End-to-end optimizer

### Local Integration Test

```bash
./test-local.sh  # Requires wasmtime
```

---

## Workflow Integration

```typescript
import { WorkflowBuilder, JobBuilder } from '@ditto/workflow-sdk';
import { keccak256, stringToBytes } from 'viem';

const wasmId = 'vault-automation-v1';
const wasmHash = keccak256(stringToBytes(wasmId)).slice(2);

const workflow = WorkflowBuilder.create(ownerAccount)
  .addCronTrigger('15 */12 * * *')  // Every 12 hours
  .addJob(
    JobBuilder.create('rebalance-job')
      .setChainId(1)

      // Step 1: WASM computes optimal weights
      .addStep({
        type: 'wasm',
        target: '0x0000000000000000000000000000000000000000',
        abi: '',
        args: [],
        wasmHash: wasmHash,
        wasmId: wasmId,
        wasmInput: {
          action: 'rebalance',
          vaultDataReader: VAULT_DATA_READER_ADDRESS,
          vault: VAULT_ADDRESS,
          protocolTypes: PROTOCOL_TYPES,
          pools: POOL_ADDRESSES,
          chainId: 1,
          config: {
            stepPct: 1,
            maxPoolShare: 0.2,
            minAllocation: 1000,
            maxVaultAllocationShare: 0.4,
          },
        },
        wasmTimeoutMs: 30000,
      })

      // Step 2: Execute rebalance with WASM output
      .addStep({
        target: VAULT_ADDRESS,
        abi: 'executeRebalance(uint256[])',
        args: ['$wasm:vault-automation-v1'],
      })
      .build()
  )
  .build();
```

---

## Project Structure

```
rebalance-wasm/
├── src/
│   ├── lib.rs              # Entry point - action dispatcher
│   ├── common.rs           # RPC, logging, output utilities
│   └── rebalance/
│       └── mod.rs          # Optimization logic (~1200 lines)
├── vaults_workflows/       # Workflow definitions
│   ├── config.ts           # Contract addresses
│   ├── rebalance-workflow.ts
│   ├── guard-updates-workflow.ts
│   └── timepoints-workflow.ts
├── build.sh
├── test-local.sh
├── test-input.json
└── yield-optimizer.wasm    # Built binary
```
