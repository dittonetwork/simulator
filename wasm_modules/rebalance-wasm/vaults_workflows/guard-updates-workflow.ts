/**
 * Guard Updates Workflow
 *
 * Updates cached guard data (Chainlink price feeds) to prevent staleness.
 *
 * Frequency: Every 30-60 minutes
 * Role: OPERATOR_ROLE
 * Criticality: HIGH - if guards go stale, vault enters protective mode
 *
 * Trigger logic:
 *   if (block.timestamp - lastUpdateTimestamp > maxStaleness * 0.8) {
 *     updateSingleGuard(guard)
 *   }
 */

import dotenv from 'dotenv';
import { WorkflowBuilder, JobBuilder } from '@ditto/workflow-sdk';
import { IpfsStorage } from '@ditto/workflow-sdk';
import { submitWorkflow } from '@ditto/workflow-sdk';
import { privateKeyToAccount } from 'viem/accounts';

import {
  GUARD_MANAGER_ADDRESS,
  CHAINLINK_PRICE_GUARD_ADDRESS,
  PROTOCOL_BLOCKLIST_GUARD_ADDRESS,
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
  console.log(`Guards:`);
  console.log(`  ChainlinkPriceGuard: ${CHAINLINK_PRICE_GUARD_ADDRESS}`);
  console.log(`  ProtocolBlocklistGuard: ${PROTOCOL_BLOCKLIST_GUARD_ADDRESS}`);
  console.log(`Schedule: ${GUARD_UPDATE_INTERVAL}\n`);

  const workflow = WorkflowBuilder.create(ownerAccount)
    .addCronTrigger(GUARD_UPDATE_INTERVAL)
    .setValidAfter(Date.now())
    .setValidUntil(Date.now() + 1000 * 60 * 60 * 24 * 365 * 15) // 15 year
    .addJob(
      JobBuilder.create('guard-update-job')
        .setChainId(MAINNET_CHAIN_ID)
        // Update ChainlinkPriceGuard
        .addStep({
          target: GUARD_MANAGER_ADDRESS,
          abi: 'updateSingleGuard(address)',
          args: [CHAINLINK_PRICE_GUARD_ADDRESS],
        })
        // Update ProtocolBlocklistGuard
        .addStep({
          target: GUARD_MANAGER_ADDRESS,
          abi: 'updateSingleGuard(address)',
          args: [PROTOCOL_BLOCKLIST_GUARD_ADDRESS],
        })
        .build()
    )
    .build();

  console.log('Workflow created:');
  console.log(`  Jobs: ${workflow.jobs.length}`);
  console.log(`  Steps: ${workflow.jobs[0].steps.length}`);
  console.log(`    1. updateSingleGuard(ChainlinkPriceGuard)`);
  console.log(`    2. updateSingleGuard(ProtocolBlocklistGuard)`);
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
