/**
 * Rebalance Workflow
 *
 * Optimizes and rebalances vault allocations across protocols.
 *
 * Frequency: Every 12-24 hours
 * Role: KEEPER_ROLE
 * Criticality: HIGH - maintains optimal yield
 *
 * Flow:
 * 1. WASM fetches vault data via VaultDataReader.getSnapshot()
 * 2. WASM runs grid search optimization
 * 3. WASM returns optimal weights as uint256[]
 * 4. Vault.executeRebalance() called with optimized weights
 *
 * Requirements:
 * - NOT in emergency mode
 * - Cooldown (12h) must have passed
 * - GuardManager guards must not be stale
 */

import dotenv from 'dotenv';
import { WorkflowBuilder, JobBuilder } from '@ditto/workflow-sdk';
import { IpfsStorage } from '@ditto/workflow-sdk';
import { submitWorkflow } from '@ditto/workflow-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, stringToBytes } from 'viem';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import {
  VAULT_ADDRESS,
  VAULT_DATA_READER_ADDRESS,
  POOL_ADDRESSES,
  PROTOCOL_TYPES,
  REBALANCE_INTERVAL,
  MAINNET_CHAIN_ID,
} from './config';

dotenv.config({ path: '.env' });

const WORKFLOW_CONTRACT_ADDRESS = process.env.WORKFLOW_CONTRACT_ADDRESS as `0x${string}`;
const OWNER_PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
const EXECUTOR_ADDRESS = process.env.EXECUTOR_ADDRESS as `0x${string}`;
const IPFS_SERVICE_URL = process.env.IPFS_SERVICE_URL as string;

if (!WORKFLOW_CONTRACT_ADDRESS || !OWNER_PRIVATE_KEY || !EXECUTOR_ADDRESS || !IPFS_SERVICE_URL) {
  console.error('Missing required environment variables');
  process.exit(1);
}

function calculateWasmHash(wasmPath: string): string {
  const wasmBytes = fs.readFileSync(wasmPath);
  return crypto.createHash('sha256').update(wasmBytes).digest('hex');
}

async function main() {
  console.log('=== Creating Rebalance Workflow ===\n');

  const storage = new IpfsStorage(IPFS_SERVICE_URL);
  const ownerAccount = privateKeyToAccount(OWNER_PRIVATE_KEY);

  // Check WASM file
  const wasmPath = path.join(__dirname, '..', 'yield-optimizer.wasm');
  if (!fs.existsSync(wasmPath)) {
    console.error(`WASM file not found: ${wasmPath}`);
    console.error('Please run: ./build.sh first');
    process.exit(1);
  }

  const wasmHash = calculateWasmHash(wasmPath);
  const wasmId = 'vault-automation-v1'; // Combined WASM module for rebalance and emergency

  console.log(`Owner: ${ownerAccount.address}`);
  console.log(`Chain: Mainnet (${MAINNET_CHAIN_ID})`);
  console.log(`Vault: ${VAULT_ADDRESS}`);
  console.log(`VaultDataReader: ${VAULT_DATA_READER_ADDRESS}`);
  console.log(`WASM Hash: ${wasmHash}`);
  console.log(`WASM ID: ${wasmId}`);
  console.log(`Schedule: ${REBALANCE_INTERVAL}\n`);

  console.log('Protocols:');
  POOL_ADDRESSES.forEach((addr, i) => {
    console.log(`  ${i + 1}. Type ${PROTOCOL_TYPES[i]}: ${addr}`);
  });
  console.log('');

  const workflow = WorkflowBuilder.create(ownerAccount)
    .addCronTrigger(REBALANCE_INTERVAL)
    .setValidAfter(Date.now())
    .setValidUntil(Date.now() + 1000 * 60 * 60 * 24 * 365 * 15) // 15 year
    .addJob(
      JobBuilder.create('rebalance-job')
        .setChainId(MAINNET_CHAIN_ID)
        // Step 1: WASM fetches vault data and optimizes
        .addStep({
          type: 'wasm' as const,
          target: '0x0000000000000000000000000000000000000000',
          abi: '',
          args: [],
          wasmHash: keccak256(stringToBytes(wasmId)).toString().slice(2),
          wasmId: wasmId,
          wasmInput: {
            action: 'rebalance',  // Explicit action (default if omitted)
            vaultDataReader: VAULT_DATA_READER_ADDRESS,
            vault: VAULT_ADDRESS,
            protocolTypes: PROTOCOL_TYPES,
            pools: POOL_ADDRESSES,
            chainId: MAINNET_CHAIN_ID,
            config: {
              stepPct: 1,        // 1% grid step
              maxPoolShare: 0.2, // Max 20% of pool TVL
              minAllocation: 1000, // Min $1000 allocation
            },
          },
          wasmTimeoutMs: 30000, // 30 seconds timeout
        } as any)
        // Step 2: Execute rebalance with optimized weights
        // SDK auto-extracts "value" field from WASM result
        .addStep({
          target: VAULT_ADDRESS,
          abi: 'executeRebalance(uint256[])',
          args: [`$wasm:${wasmId}`], // SDK extracts result.value (weights in WAD format)
        })
        .build()
    )
    .build();

  console.log('Workflow created:');
  console.log(`  Jobs: ${workflow.jobs.length}`);
  console.log(`  Steps: ${workflow.jobs[0].steps.length}`);
  console.log(`    1. WASM optimizer: ${wasmId}`);
  console.log(`    2. executeRebalance on vault`);
  console.log(`  Trigger: ${REBALANCE_INTERVAL}\n`);

  console.log('Submitting workflow...');
  try {
    const response = await submitWorkflow(
      workflow,
      EXECUTOR_ADDRESS,
      storage,
      ownerAccount,
      true,
      IPFS_SERVICE_URL,
    );

    console.log('\nWorkflow submitted successfully!');
    console.log(`  IPFS Hash: ${response.ipfsHash}`);
    response.userOpHashes.forEach((hash, i) => {
      console.log(`  Job ${i + 1}: ${hash.userOpHash || hash.receipt?.transactionHash || 'N/A'}`);
    });

    console.log('\nIMPORTANT: Ensure WASM module is indexed in MongoDB!');
    console.log(`  WASM Hash: ${wasmHash}`);
    console.log(`  WASM ID: ${wasmId}`);
  } catch (error) {
    console.error('\nFailed to submit workflow:', error);
    process.exit(1);
  }
}

main().catch(console.error);
