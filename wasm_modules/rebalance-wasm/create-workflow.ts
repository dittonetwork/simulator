/**
 * Yield Optimizer Workflow (RPC-Enabled, Cross-Chain)
 *
 * This script creates a workflow that:
 * 1. Executes a WASM module that:
 *    - Makes RPC call to VaultDataReader.getSnapshot() on Ethereum mainnet
 *    - Fetches real-time data for 5 protocols (Aave, Spark, Fluid, 2x Morpho)
 *    - Transforms WAD/BPS values to decimals
 *    - Runs grid search optimization to find optimal allocations
 *    - Returns allocations as uint256[5] hex strings
 * 2. Submits result to mock allocation contract on Base
 *
 * Architecture:
 *   - Data Source: Ethereum Mainnet (VaultDataReader)
 *   - Execution: Base (allocation contract)
 *   - WASM uses file-based RPC protocol to communicate with host
 *   - All operators fetch data at same block height for determinism
 */

import dotenv from 'dotenv';
import { WorkflowBuilder, JobBuilder } from '@ditto/workflow-sdk';
import { IpfsStorage } from '@ditto/workflow-sdk';
import { submitWorkflow } from '@ditto/workflow-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, base } from 'viem/chains';
import { keccak256, stringToBytes } from 'viem';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

dotenv.config({ path: '../../.env' });

const WORKFLOW_CONTRACT_ADDRESS = process.env.WORKFLOW_CONTRACT_ADDRESS as `0x${string}`;
const OWNER_PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
const EXECUTOR_ADDRESS = process.env.EXECUTOR_ADDRESS as `0x${string}`;
const IPFS_SERVICE_URL = process.env.IPFS_SERVICE_URL as string;

if (!WORKFLOW_CONTRACT_ADDRESS || !OWNER_PRIVATE_KEY || !EXECUTOR_ADDRESS || !IPFS_SERVICE_URL) {
  console.error('Missing required environment variables:');
  console.error('  WORKFLOW_CONTRACT_ADDRESS');
  console.error('  PRIVATE_KEY');
  console.error('  EXECUTOR_ADDRESS');
  console.error('  IPFS_SERVICE_URL');
  process.exit(1);
}

/**
 * Calculate SHA256 hash of WASM file
 */
function calculateWasmHash(wasmPath: string): string {
  const wasmBytes = fs.readFileSync(wasmPath);
  return crypto.createHash('sha256').update(wasmBytes).digest('hex');
}

/**
 * Mainnet Contract Addresses (for RPC data fetching)
 */
// VaultDataReader deployed on mainnet
const VAULT_DATA_READER_ADDRESS = '0xf9f69D1bA1007A34bDAdAc55879AC406A3e38250';

// Underlying asset
const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// Protocol pools/vaults (mainnet)
const AAVE_POOL_ADDRESS = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';     // Aave V3 Pool
const SPARK_POOL_ADDRESS = '0xC13e21B648A5Ee794902342038FF3aDAB66BE987';    // Spark Pool
const FLUID_FUSDC_ADDRESS = '0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33';   // Fluid fUSDC Vault
const MORPHO_GAUNTLET_ADDRESS = '0xdd0f28e19C1780eb6396170735D45153D261490d'; // Gauntlet USDC Prime
const MORPHO_STEAKHOUSE_ADDRESS = '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB'; // Steakhouse USDC

/**
 * Base Contract Addresses (for submitting results)
 */
// Mock allocation contract on Base
const ALLOCATION_CONTRACT_ADDRESS = '0x36bFE8f9dC9b62C681D20e0019BCD85675a9E494';

async function main() {
  console.log('=== Creating Yield Optimizer Workflow ===\n');

  // Initialize storage
  const storage = new IpfsStorage(IPFS_SERVICE_URL);
  const ownerAccount = privateKeyToAccount(OWNER_PRIVATE_KEY);

  // Check if WASM file exists
  const wasmPath = path.join(__dirname, 'yield-optimizer.wasm');
  if (!fs.existsSync(wasmPath)) {
    console.error(`WASM file not found: ${wasmPath}`);
    console.error('Please run: ./build.sh first');
    process.exit(1);
  }

  // Calculate WASM hash
  const wasmHash = calculateWasmHash(wasmPath);
  console.log(`WASM hash (SHA256): ${wasmHash}`);
  console.log(`⚠️  Make sure this WASM module is already indexed in MongoDB!\n`);

  console.log(`Owner (Smart Account): ${ownerAccount.address}`);
  console.log(`\nData Source: Ethereum Mainnet (${mainnet.id})`);
  console.log(`  VaultDataReader: ${VAULT_DATA_READER_ADDRESS}`);
  console.log(`\nResult Submission: Base (${base.id})`);
  console.log(`  Allocation Contract: ${ALLOCATION_CONTRACT_ADDRESS}`);
  console.log(`\nProtocols (5):`);
  console.log(`  1. Aave V3 Pool: ${AAVE_POOL_ADDRESS}`);
  console.log(`  2. Spark Pool: ${SPARK_POOL_ADDRESS}`);
  console.log(`  3. Fluid fUSDC: ${FLUID_FUSDC_ADDRESS}`);
  console.log(`  4. Morpho Gauntlet: ${MORPHO_GAUNTLET_ADDRESS}`);
  console.log(`  5. Morpho Steakhouse: ${MORPHO_STEAKHOUSE_ADDRESS}\n`);

  // Create workflow
  const wasmId = 'rebalance-wasm-v1';

  const workflow = WorkflowBuilder.create(ownerAccount)
    // .addCronTrigger('0 */12 * * *') // Every 12 hours (rebalance cooldown)
    .addCronTrigger('*/2 * * * *') // Every 12 hours (rebalance cooldown)
    .setCount(1) // Execute 100 times
    // .setCount(100) // Execute 100 times
    .setValidAfter(Date.now())
    .setValidUntil(Date.now() + 1000 * 60 * 60 * 24 * 365) // Valid for 1 year
    .addJob(
      JobBuilder.create('rebalance-job')
        .setChainId(base.id) // Execute on Base
        .addStep({
          // Step 1: WASM fetches vault data via RPC (from mainnet) and optimizes
          type: 'wasm' as const,
          target: '0x0000000000000000000000000000000000000000',
          abi: '',
          args: [],
          wasmHash: keccak256(stringToBytes(wasmId)).toString().slice(2),
          wasmId: wasmId,
          wasmInput: {
            vaultDataReader: VAULT_DATA_READER_ADDRESS,
            vault: ALLOCATION_CONTRACT_ADDRESS, // Used for context, actual submission is separate
            // Protocol types: 1=AaveV3, 2=Spark (uses Aave interface), 3=Fluid, 4=MetaMorpho
            protocolTypes: [1, 1, 3, 4, 4], // Aave, Spark (Aave-like), Fluid, Morpho Gauntlet, Morpho Steakhouse
            pools: [
              AAVE_POOL_ADDRESS,
              SPARK_POOL_ADDRESS,
              FLUID_FUSDC_ADDRESS,
              MORPHO_GAUNTLET_ADDRESS,
              MORPHO_STEAKHOUSE_ADDRESS,
            ],
            chainId: mainnet.id, // RPC calls go to mainnet
            config: {
              stepPct: 1,        // 1% grid step
              maxPoolShare: 0.2, // Max 20% of pool TVL
              minAllocation: 1000, // Min $1000 allocation (in USDC decimals, so 1000e6 = $1000)
            },
          },
          wasmTimeoutMs: 30000, // 30 seconds timeout (RPC + computation for 5 protocols)
        } as any)
        .addStep({
          // Step 2: Submit allocation to mock contract on Base
          target: ALLOCATION_CONTRACT_ADDRESS,
          abi: 'submitAllocation(uint256[5])',
          // Pass WASM optimization results as fixed-size allocation array
          // The '$wasm:' prefix references the WASM result
          args: [`$wasm:${wasmId}`],
        } as any)
        .build()
    )
    .build();

  console.log('Workflow created:');
  console.log(`  Owner: ${(workflow.owner as any).address || workflow.owner}`);
  console.log(`  Execution Chain: Base (${base.id})`);
  console.log(`  Data Source: Mainnet (${mainnet.id}) via RPC`);
  console.log(`  Trigger: Every 12 hours`);
  console.log(`  Jobs: ${workflow.jobs.length}`);
  console.log(`  Steps in job: ${workflow.jobs[0].steps.length}`);
  console.log(`    - WASM step (RPC-enabled): ${(workflow.jobs[0].steps[0] as any).wasmId}`);
  console.log(`    - Protocols: 5 (Aave, Spark, Fluid, Morpho Gauntlet, Morpho Steakhouse)`);
  console.log(`    - submitAllocation call to: ${workflow.jobs[0].steps[1].target}\n`);

  // Submit workflow
  console.log('Submitting workflow...');
  try {
    const response = await submitWorkflow(
      workflow,
      EXECUTOR_ADDRESS,
      storage,
      ownerAccount,
      true, // prodContract
      IPFS_SERVICE_URL,
    );

    console.log('\n✅ Workflow submitted successfully!');
    console.log(`  IPFS Hash: ${response.ipfsHash}`);
    console.log(`  UserOp Hashes: ${response.userOpHashes.length}`);
    response.userOpHashes.forEach((hash, i) => {
      console.log(`    Job ${i + 1}: ${hash.userOpHash || hash.receipt?.transactionHash || 'N/A'}`);
    });

    console.log('\n⚠️  IMPORTANT: Make sure the WASM module is indexed in MongoDB!');
    console.log(`   WASM Hash: ${wasmHash}`);
    console.log(`   WASM ID: ${wasmId}`);

  } catch (error) {
    console.error('\n❌ Failed to submit workflow:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
