/**
 * Guard Updates Workflow
 *
 * Updates all guard data and auto-activates emergency mode if triggers detected.
 *
 * Frequency: Every 30 minutes
 * Role: OPERATOR_ROLE
 * Criticality: HIGH - if guards go stale, vault enters protective mode
 *
 * New behavior (v2):
 * - Uses updateAllGuards() instead of individual updateSingleGuard() calls
 * - updateAllGuards() auto-activates emergency mode if any guard triggers
 * - Returns (uint8 blockedMask, bool withdrawAll) for immediate action
 * - Eliminates need for separate emergency monitoring workflow
 */

import dotenv from 'dotenv';
import { WorkflowBuilder, JobBuilder } from '@ditto/workflow-sdk';
import { IpfsStorage } from '@ditto/workflow-sdk';
import { submitWorkflow } from '@ditto/workflow-sdk';
import { privateKeyToAccount } from 'viem/accounts';

import {
  GUARD_MANAGER_ADDRESS,
  GUARD_UPDATE_INTERVAL,
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
  console.log('=== Creating Guard Updates Workflow ===\n');

  const storage = new IpfsStorage(IPFS_SERVICE_URL);
  const ownerAccount = privateKeyToAccount(OWNER_PRIVATE_KEY);

  console.log(`Owner: ${ownerAccount.address}`);
  console.log(`Chain: Mainnet (${MAINNET_CHAIN_ID})`);
  console.log(`GuardManager: ${GUARD_MANAGER_ADDRESS}`);
  console.log(`Schedule: ${GUARD_UPDATE_INTERVAL}\n`);

  // Single step workflow using updateAllGuards()
  // This updates all registered guards and auto-activates emergency mode if needed
  const workflow = WorkflowBuilder.create(ownerAccount)
    .addCronTrigger(GUARD_UPDATE_INTERVAL)
    .setValidAfter(Date.now())
    .setValidUntil(Date.now() + 1000 * 60 * 60 * 24 * 365 * 15) // 15 year
    .addJob(
      JobBuilder.create('guard-update-job')
        .setChainId(MAINNET_CHAIN_ID)
        // Update all guards in one call - auto-activates emergency if triggers detected
        .addStep({
          target: GUARD_MANAGER_ADDRESS,
          abi: 'updateAllGuards()',
          args: [],
        })
        .build()
    )
    .build();

  console.log('Workflow created:');
  console.log(`  Jobs: ${workflow.jobs.length}`);
  console.log(`  Steps: ${workflow.jobs[0].steps.length}`);
  console.log(`    1. updateAllGuards() - updates all guards, auto-activates emergency if needed`);
  console.log(`  Trigger: ${GUARD_UPDATE_INTERVAL}\n`);

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
