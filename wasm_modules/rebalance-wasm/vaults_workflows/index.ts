/**
 * Vault Automation Workflows Index
 *
 * This module provides automation workflows for YieldSplitVault operations.
 *
 * Available Workflows:
 *
 * 1. guard-updates-workflow.ts
 *    - Updates guard cached data (Chainlink prices)
 *    - Frequency: Every 30 minutes
 *    - Role: OPERATOR_ROLE
 *    - Criticality: HIGH
 *
 * 2. rebalance-workflow.ts
 *    - Optimizes and rebalances vault allocations
 *    - Frequency: Every 12 hours
 *    - Role: KEEPER_ROLE
 *    - Criticality: HIGH
 *
 * 3. timepoints-workflow.ts
 *    - Records MetaMorpho vault snapshots for APY calculation
 *    - Frequency: Every 2 hours
 *    - Role: Public
 *    - Criticality: MEDIUM
 *
 * 4. emergency-workflow.ts
 *    - Monitors and activates emergency mode when needed
 *    - Frequency: Every 5 minutes
 *    - Role: OPERATOR_ROLE
 *    - Criticality: CRITICAL
 *
 * Usage:
 *   bun run guard-updates-workflow.ts
 *   bun run rebalance-workflow.ts
 *   bun run timepoints-workflow.ts
 *   bun run emergency-workflow.ts
 *
 * Before running:
 *   1. Update config.ts with deployed contract addresses
 *   2. Set environment variables in .env
 *   3. Build WASM module: ./build.sh
 *   4. Index WASM in MongoDB
 */

export * from './config';
