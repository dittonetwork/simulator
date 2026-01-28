# Vault Automation WASM Module

WASM module for YieldSplitVault automation: yield optimization and emergency monitoring.

## Overview

This module provides two core functions for vault automation:

1. **Rebalance Optimizer** - Grid search optimization across lending protocols
2. **Emergency Monitor** - Guard status monitoring with conditional execution

Both share a single WASM binary with action-based dispatching.

## Features

### Rebalance Optimizer
- Grid search across all weight combinations
- Protocol support: Aave V3, Spark, Fluid V2, MetaMorpho
- IRM simulation for accurate APY calculations
- Constraint handling: TVL caps, blocked adapters, min allocations
- RPC integration via VaultDataReader

### Emergency Monitor
- Checks GuardManager aggregated status
- Validates guard data freshness (<5 min)
- Returns `skipRemainingSteps: true` when no action needed
- Enables conditional workflow execution

## Build

```bash
./build.sh
```

Generates `yield-optimizer.wasm` (~305KB).

## Architecture

```
src/
├── lib.rs              # Entry point - dispatches by "action" field
├── common.rs           # Shared: RPC, logging, output helpers
├── rebalance/
│   └── mod.rs          # Yield optimization logic
└── emergency/
    └── mod.rs          # Guard monitoring logic
```

## Input Format

### Rebalance (action: "rebalance")

```json
{
  "action": "rebalance",
  "vaultDataReader": "0x...",
  "vault": "0x...",
  "protocolTypes": [1, 3, 4, 4, 2],
  "pools": ["0x...", "0x...", "0x...", "0x...", "0x..."],
  "chainId": 1,
  "config": {
    "stepPct": 1,
    "maxPoolShare": 0.2,
    "minAllocation": 1000
  }
}
```

Legacy mode (without RPC):
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
  "config": { "stepPct": 1, "maxPoolShare": 0.2, "minAllocation": 1000 }
}
```

### Emergency Check (action: "emergency-check")

```json
{
  "action": "emergency-check",
  "guardManager": "0x...",
  "vault": "0x...",
  "chainId": 1
}
```

## Output Format

### Rebalance Output

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "success": true,
    "value": ["0x0de0b6b3a7640000", "0x1bc16d674ec80000", ...],
    "weights": ["0x0de0b6b3a7640000", ...],
    "weightsDecimal": [0.1, 0.2, 0.3, 0.2, 0.2],
    "allocations": ["0x...", ...],
    "allocationsDecimal": [1000000, 2000000, ...],
    "expectedReturn12h": 1234.56,
    "expectedApyWeighted": 0.045,
    "apys": [0.04, 0.035, 0.08, 0.06, 0.055],
    "scenariosEvaluated": 4598126,
    "timeMs": 234.5
  }
}
```

### Emergency Check Output (no action needed)

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "success": true,
    "skipRemainingSteps": true,
    "message": "All guards normal, no action needed"
  }
}
```

### Emergency Check Output (action needed)

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "success": true,
    "shouldActivate": true,
    "aggregatedStatus": 1,
    "isEmergencyMode": false,
    "dataFresh": true,
    "message": "Guard(s) triggered with fresh data, activating emergency mode"
  }
}
```

## Workflow Integration

### Rebalance Workflow

```typescript
// Step 1: WASM optimizes allocations
.addStep({
  type: 'wasm',
  wasmId: 'vault-automation-v1',
  wasmInput: {
    action: 'rebalance',
    vaultDataReader: VAULT_DATA_READER,
    vault: VAULT_ADDRESS,
    protocolTypes: [1, 3, 4, 4, 2],
    pools: [...],
    chainId: 1,
  },
})
// Step 2: Execute rebalance with optimized weights
.addStep({
  target: VAULT_ADDRESS,
  abi: 'executeRebalance(uint256[])',
  args: ['$wasm:vault-automation-v1'],
})
```

### Emergency Workflow (with skip support)

```typescript
// Step 1: WASM checks guards - returns skipRemainingSteps if no action needed
.addStep({
  type: 'wasm',
  wasmId: 'vault-automation-v1',
  wasmInput: {
    action: 'emergency-check',
    guardManager: GUARD_MANAGER,
    vault: VAULT_ADDRESS,
    chainId: 1,
  },
})
// Step 2: Only executed if WASM didn't skip
.addStep({
  target: GUARD_MANAGER,
  abi: 'activateEmergencyMode()',
  args: [],
})
```

## Protocol Types

| Type | Protocol |
|------|----------|
| 1 | Aave V3 |
| 2 | Spark |
| 3 | Fluid V2 |
| 4 | MetaMorpho |

## Testing Locally

```bash
# Install wasmtime
curl https://wasmtime.dev/install.sh -sSf | bash

# Test rebalance
echo '{"action":"rebalance","totalAssets":10000000,"protocols":[...],"blockedMask":0}' | \
  wasmtime yield-optimizer.wasm

# Test emergency check (requires RPC environment)
WASM_RPC_WORK_DIR=/tmp \
echo '{"action":"emergency-check","guardManager":"0x...","vault":"0x...","chainId":1}' | \
  wasmtime yield-optimizer.wasm
```

## Algorithm

### Rebalance
1. **Grid Generation**: All weight combinations summing to 100%
2. **Constraint Filtering**: TVL caps, blocked adapters, min allocations
3. **IRM Simulation**: Protocol-specific APY calculations
4. **Optimization**: Select maximum expected 12h return

### Emergency Monitor
1. Check `GuardManager.isEmergencyMode()` - skip if already active
2. Check `GuardManager.getAggregatedStatus()` - skip if NORMAL
3. Fetch registered guards and check data freshness
4. If triggered + fresh (<5 min): proceed to activate
5. Otherwise: return `skipRemainingSteps: true`

## Workflows

| File | Purpose | Frequency |
|------|---------|-----------|
| `rebalance-workflow.ts` | Yield optimization | Every 12h |
| `emergency-workflow.ts` | Guard monitoring | Every 5min |
| `guard-updates-workflow.ts` | Update guard caches | Every 30min |

## License

MIT
