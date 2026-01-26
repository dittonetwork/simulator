/**
 * MetaMorpho Timepoints Workflow
 *
 * Records historical data for APY calculation of MetaMorpho vaults.
 *
 * Frequency: Every 1-4 hours
 * Role: Public (anyone can call)
 * Criticality: MEDIUM - without timepoints, APY estimation is inaccurate
 *
 * Records vault totalAssets and totalSupply snapshots.
 * Uses ring buffer with 512 slots, 7-day lookback window.
 * Minimum interval between records: 1 hour.
 */

import dotenv from 'dotenv';
import { WorkflowBuilder, JobBuilder } from '@ditto/workflow-sdk';
import { IpfsStorage } from '@ditto/workflow-sdk';
import { submitWorkflow } from '@ditto/workflow-sdk';
import { privateKeyToAccount } from 'viem/accounts';

import {
  MORPHO_GAUNTLET_ESTIMATOR_ADDRESS,
  MORPHO_STEAKHOUSE_ESTIMATOR_ADDRESS,
  TIMEPOINT_INTERVAL,
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
  console.log('=== Creating MetaMorpho Timepoints Workflow ===\n');

  const storage = new IpfsStorage(IPFS_SERVICE_URL);
  const ownerAccount = privateKeyToAccount(OWNER_PRIVATE_KEY);

  console.log(`Owner: ${ownerAccount.address}`);
  console.log(`Chain: Mainnet (${MAINNET_CHAIN_ID})`);
  console.log(`Morpho Gauntlet Estimator: ${MORPHO_GAUNTLET_ESTIMATOR_ADDRESS}`);
  console.log(`Morpho Steakhouse Estimator: ${MORPHO_STEAKHOUSE_ESTIMATOR_ADDRESS}`);
  console.log(`Schedule: ${TIMEPOINT_INTERVAL}\n`);

  const workflow = WorkflowBuilder.create(ownerAccount)
    .addCronTrigger(TIMEPOINT_INTERVAL)
    .setValidAfter(Date.now())
    .setValidUntil(Date.now() + 1000 * 60 * 60 * 24 * 365 * 15) // 15 year
    .addJob(
      JobBuilder.create('timepoints-job')
        .setChainId(MAINNET_CHAIN_ID)
        // Record timepoint for Morpho Gauntlet
        .addStep({
          target: MORPHO_GAUNTLET_ESTIMATOR_ADDRESS,
          abi: 'recordTimepoint()',
          args: [],
        })
        // Record timepoint for Morpho Steakhouse
        .addStep({
          target: MORPHO_STEAKHOUSE_ESTIMATOR_ADDRESS,
          abi: 'recordTimepoint()',
          args: [],
        })
        .build()
    )
    .build();

  console.log('Workflow created:');
  console.log(`  Jobs: ${workflow.jobs.length}`);
  console.log(`  Steps: ${workflow.jobs[0].steps.length}`);
  console.log(`  Trigger: ${TIMEPOINT_INTERVAL}\n`);

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
