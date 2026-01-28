# Vault Automation Workflows

Automated workflows for YieldSplitVault keeper operations.

## Overview

| Workflow | Frequency | Role | Criticality | Description |
|----------|-----------|------|-------------|-------------|
| Guard Updates | 30 min | OPERATOR | **HIGH** | Updates Chainlink price feeds |
| Rebalance | 12 hours | KEEPER | **HIGH** | Optimizes allocations |
| Timepoints | 2 hours | Public | MEDIUM | Records MetaMorpho APY data |
| Emergency | 5 min | OPERATOR | **CRITICAL** | Monitors & activates emergency |

## Setup

### 1. Update Configuration

Edit `config.ts` with your deployed contract addresses:

```typescript
// Core contracts (after deployment)
export const VAULT_ADDRESS = '0x...';
export const GUARD_MANAGER_ADDRESS = '0x...';
export const RETURN_ESTIMATOR_ADDRESS = '0x...';

// Adapters
export const AAVE_ADAPTER_ADDRESS = '0x...';
// ... etc

// Estimators
export const MORPHO_GAUNTLET_ESTIMATOR_ADDRESS = '0x...';
// ... etc

// Guards
export const CHAINLINK_PRICE_GUARD_ADDRESS = '0x...';
```

### 2. Environment Variables

Create `.env`:

```bash
WORKFLOW_CONTRACT_ADDRESS=0x...
PRIVATE_KEY=0x...
EXECUTOR_ADDRESS=0x...
IPFS_SERVICE_URL=https://...
```

### 3. Build WASM Module

```bash
cd /Users/binarch/work/dittonetwork/simulator/wasm_modules/rebalance-wasm
./build.sh
```

### 4. Index WASM in MongoDB

Ensure the WASM module is indexed before running rebalance workflow.

## Running Workflows

```bash
# From vaults_workflows directory
cd /Users/binarch/work/dittonetwork/simulator/wasm_modules/rebalance-wasm/vaults_workflows

# Guard Updates (every 30 min)
bun run guard-updates-workflow.ts

# Rebalance (every 12 hours)
bun run rebalance-workflow.ts

# MetaMorpho Timepoints (every 2 hours)
bun run timepoints-workflow.ts

# Emergency Monitoring (every 5 minutes)
bun run emergency-workflow.ts
```

## Workflow Details

### 1. Guard Updates (`guard-updates-workflow.ts`)

Updates cached guard data to prevent staleness. If guards go stale (>1 hour by default), the vault enters protective mode.

**Contract**: `GuardManager.updateSingleGuard(address guard)`

**Logic**:
```
if (block.timestamp - lastUpdateTimestamp > maxStaleness * 0.8) {
    updateSingleGuard(guard)
}
```

### 2. Rebalance (`rebalance-workflow.ts`)

Uses WASM optimizer to find optimal allocation weights and executes rebalance.

**Steps**:
1. WASM fetches vault data via `VaultDataReader.getSnapshot()`
2. WASM runs grid search optimization (1% step, 20% max pool share)
3. WASM returns optimal weights
4. Calls `Vault.executeRebalance(weights)`

**Requirements**:
- NOT in emergency mode
- 12-hour cooldown passed
- Guards not stale
- Return improvement > minRebalanceImprovementBps

### 3. Timepoints (`timepoints-workflow.ts`)

Records snapshots for MetaMorpho APY estimation.

**Contract**: `MetaMorphoEstimator.recordTimepoint()`

**Details**:
- Ring buffer with 512 slots
- 7-day lookback window
- Minimum 1 hour between records
- Without timepoints, uses fallback APY (5%)

### 4. Emergency (`emergency-workflow.ts`)

Monitors guard status and activates emergency mode when triggered.

**Activation Conditions**:
- At least one guard in TRIGGERED state
- Guard data < 5 minutes old
- Called by OPERATOR_ROLE

**Emergency Mode Effects**:
- Deposits blocked
- Only `emergencyRebalance()` available (PROTOCOL_ADMIN)
- No cooldown or return improvement checks

## Roles Required

| Role | Address | Used By |
|------|---------|---------|
| PROTOCOL_ADMIN | - | emergencyRebalance, deactivateEmergency |
| KEEPER_ROLE | Executor | executeRebalance |
| OPERATOR_ROLE | Executor | updateGuards, activateEmergency |

## Monitoring

### Critical Alerts
- Emergency mode activated
- Guard data stale > 2x maxStaleness
- Rebalance not executed > 48 hours

### Warnings
- Any guard in CAUTION state
- High gas prices for keeper ops
- Weight deviation > 10% from target

### Informational
- Successful rebalance
- Timepoint recorded
- Guards updated

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Workflow Orchestration                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ Guard Update │  │  Rebalance   │  │  Timepoints  │           │
│  │   (30 min)   │  │   (12 hrs)   │  │    (2 hrs)   │           │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘           │
│         │                 │                 │                   │
│         ▼                 ▼                 ▼                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ GuardManager │  │ WASM + Vault │  │  Estimators  │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                 Emergency Monitoring (5 min)                    │
│         ┌─────────────────────────────────────────┐             │
│         │ Check Guards → Activate Emergency Mode  │             │
│         └─────────────────────────────────────────┘             │
└─────────────────────────────────────────────────────────────────┘
```
