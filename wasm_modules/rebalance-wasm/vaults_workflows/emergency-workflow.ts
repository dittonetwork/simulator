/**
 * Emergency Monitoring Workflow
 *
 * Monitors guard state and activates emergency mode when necessary.
 *
 * Frequency: Every 5 minutes
 * Role: OPERATOR_ROLE
 * Criticality: CRITICAL - protects funds in case of depeg/attack
 *
 * Flow:
 * 1. WASM checks guard staleness and status via RPC
 * 2. If guards are NORMAL, WASM returns skipRemainingSteps=true
 * 3. If guard triggered and data fresh (<5 min), proceed to step 2
 * 4. Execute activateEmergencyMode() if needed
 *
 * Emergency Mode Conditions:
 * - At least one guard in TRIGGERED state
 * - Guard data must be fresh (< 5 minutes old)
 * - Called by OPERATOR_ROLE or vault itself
 */

import dotenv from 'dotenv';
import { WorkflowBuilder, JobBuilder } from '@ditto/workflow-sdk';
import { IpfsStorage } from '@ditto/workflow-sdk';
import { submitWorkflow } from '@ditto/workflow-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, stringToBytes } from 'viem';

import {
  VAULT_ADDRESS,
  GUARD_MANAGER_ADDRESS,
  EMERGENCY_CHECK_INTERVAL,
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

async function main() {
  console.log('=== Creating Emergency Monitoring Workflow ===\n');

  const storage = new IpfsStorage(IPFS_SERVICE_URL);
  const ownerAccount = privateKeyToAccount(OWNER_PRIVATE_KEY);

  // WASM ID for the combined vault automation module
  const wasmId = 'vault-automation-v1';

  console.log(`Owner: ${ownerAccount.address}`);
  console.log(`Chain: Mainnet (${MAINNET_CHAIN_ID})`);
  console.log(`Vault: ${VAULT_ADDRESS}`);
  console.log(`GuardManager: ${GUARD_MANAGER_ADDRESS}`);
  console.log(`Schedule: ${EMERGENCY_CHECK_INTERVAL}\n`);

  // Emergency workflow with skip support:
  // - WASM checks guard status via RPC
  // - If no action needed, returns skipRemainingSteps=true and step 2 is skipped
  // - If action needed, step 2 activates emergency mode
  const workflow = WorkflowBuilder.create(ownerAccount)
    .addCronTrigger(EMERGENCY_CHECK_INTERVAL)
    .setValidAfter(Date.now())
    .setValidUntil(Date.now() + 1000 * 60 * 60 * 24 * 365 * 15) // 15 years
    .addJob(
      JobBuilder.create('emergency-check-job')
        .setChainId(MAINNET_CHAIN_ID)
        // Step 1: WASM checks guard status via RPC
        // If guards are NORMAL or data is stale, returns skipRemainingSteps=true
        .addStep({
          type: 'wasm' as const,
          target: '0x0000000000000000000000000000000000000000',
          abi: '',
          args: [],
          wasmHash: keccak256(stringToBytes(wasmId)).toString().slice(2),
          wasmId: wasmId,
          wasmInput: {
            action: 'emergency-check',
            guardManager: GUARD_MANAGER_ADDRESS,
            vault: VAULT_ADDRESS,
            chainId: MAINNET_CHAIN_ID,
          },
          wasmTimeoutMs: 15000, // 15 seconds for RPC calls
        } as any)
        // Step 2: Activate emergency mode (only executed if WASM didn't skip)
        .addStep({
          target: GUARD_MANAGER_ADDRESS,
          abi: 'activateEmergencyMode()',
          args: [],
        })
        .build()
    )
    .build();

  console.log('Workflow created:');
  console.log(`  Jobs: ${workflow.jobs.length}`);
  console.log(`  Steps: ${workflow.jobs[0].steps.length}`);
  console.log(`    1. WASM emergency-check (with skip support)`);
  console.log(`    2. activateEmergencyMode() (skipped if not needed)`);
  console.log(`  Trigger: ${EMERGENCY_CHECK_INTERVAL}\n`);

  console.log('Emergency Monitor Logic:');
  console.log('  - Checks GuardManager.getAggregatedStatus()');
  console.log('  - If NORMAL (0): skipRemainingSteps=true');
  console.log('  - If CAUTION/EMERGENCY: checks data freshness');
  console.log('  - If data fresh (<5min): proceeds to activateEmergencyMode()');
  console.log('  - If data stale: skipRemainingSteps=true (cannot activate)\n');

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
  } catch (error) {
    console.error('\nFailed to submit workflow:', error);
    process.exit(1);
  }
}

main().catch(console.error);
