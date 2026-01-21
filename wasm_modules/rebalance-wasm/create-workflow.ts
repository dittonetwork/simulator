/**
 * Yield Optimizer Workflow (RPC-Enabled)
 *
 * This script creates a workflow that:
 * 1. Executes a WASM module that:
 *    - Makes RPC call to VaultDataReader.getSnapshot() to fetch real-time vault state
 *    - Transforms WAD/BPS values to decimals
 *    - Runs grid search optimization to find optimal allocations
 *    - Returns allocations as uint256[] hex strings
 * 2. Calls YieldSplitVault.executeRebalance() with the optimized allocations
 *
 * The WASM module uses the file-based RPC protocol to communicate with the host.
 * All operators will fetch data at the same block height for determinism.
 */

import dotenv from 'dotenv';
import { WorkflowBuilder, JobBuilder } from '@ditto/workflow-sdk';
import { IpfsStorage } from '@ditto/workflow-sdk';
import { submitWorkflow } from '@ditto/workflow-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
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
 * Contract addresses (update these for your deployment)
 */
const VAULT_DATA_READER_ADDRESS = '0x0000000000000000000000000000000000000001'; // TODO: Deploy VaultDataReader
const YIELD_SPLIT_VAULT_ADDRESS = '0x0000000000000000000000000000000000000002'; // TODO: Deploy YieldSplitVault
const AAVE_POOL_ADDRESS = '0x0000000000000000000000000000000000000003';
const SPARK_POOL_ADDRESS = '0x0000000000000000000000000000000000000004';
const FLUID_VAULT_ADDRESS = '0x0000000000000000000000000000000000000005';
const MORPHO_VAULT_ADDRESS = '0x0000000000000000000000000000000000000006';

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
  console.log(`VaultDataReader: ${VAULT_DATA_READER_ADDRESS}`);
  console.log(`YieldSplitVault: ${YIELD_SPLIT_VAULT_ADDRESS}\n`);

  // Create workflow
  const wasmId = 'rebalance-optimizer';

  const workflow = WorkflowBuilder.create(ownerAccount)
    .addCronTrigger('0 */12 * * *') // Every 12 hours (rebalance cooldown)
    .setCount(100) // Execute 100 times
    .setValidAfter(Date.now())
    .setValidUntil(Date.now() + 1000 * 60 * 60 * 24 * 365) // Valid for 1 year
    .addJob(
      JobBuilder.create('rebalance-job')
        .setChainId(baseSepolia.id)
        .addStep({
          // Step 1: WASM fetches vault data via RPC and optimizes
          type: 'wasm' as const,
          target: '0x0000000000000000000000000000000000000000',
          abi: '',
          args: [],
          wasmHash: keccak256(stringToBytes(wasmId)).toString().slice(2),
          wasmId: wasmId,
          wasmInput: {
            vaultDataReader: VAULT_DATA_READER_ADDRESS,
            vault: YIELD_SPLIT_VAULT_ADDRESS,
            protocolTypes: [1, 2, 3, 4], // AaveV3, Spark, Fluid, MetaMorpho
            pools: [
              AAVE_POOL_ADDRESS,
              SPARK_POOL_ADDRESS,
              FLUID_VAULT_ADDRESS,
              MORPHO_VAULT_ADDRESS,
            ],
            chainId: baseSepolia.id,
            config: {
              stepPct: 1,        // 1% grid step
              maxPoolShare: 0.2, // Max 20% of pool TVL
              minAllocation: 1000, // Min $1000 allocation
            },
          },
          wasmTimeoutMs: 15000, // 15 seconds timeout (RPC + computation)
        } as any)
        .addStep({
          // Step 2: Call YieldSplitVault.executeRebalance with optimized allocations
          target: YIELD_SPLIT_VAULT_ADDRESS,
          abi: JSON.stringify([
            {
              name: 'executeRebalance',
              type: 'function',
              stateMutability: 'nonpayable',
              inputs: [
                {
                  name: 'allocations',
                  type: 'uint256[]',
                  internalType: 'uint256[]',
                },
              ],
              outputs: [],
            },
          ]),
          // Pass WASM optimization results as allocations array
          // The '$wasm:' prefix references the WASM result
          args: [`$wasm:${wasmId}.allocations`],
        } as any)
        .build()
    )
    .build();

  console.log('Workflow created:');
  console.log(`  Owner: ${(workflow.owner as any).address || workflow.owner}`);
  console.log(`  Trigger: Every 12 hours`);
  console.log(`  Jobs: ${workflow.jobs.length}`);
  console.log(`  Steps in job: ${workflow.jobs[0].steps.length}`);
  console.log(`    - WASM step (RPC-enabled): ${(workflow.jobs[0].steps[0] as any).wasmId}`);
  console.log(`    - executeRebalance call to: ${workflow.jobs[0].steps[1].target}\n`);

  // Submit workflow
  console.log('Submitting workflow...');
  try {
    const response = await submitWorkflow(
      workflow,
      EXECUTOR_ADDRESS,
      storage,
      ownerAccount,
      false, // prodContract
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
