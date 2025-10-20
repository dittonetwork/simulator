import dotenv, { config } from 'dotenv';
import { z } from 'zod';

import { getChainConfig, CHAINS } from '@ditto/workflow-sdk';
import { Wallet } from 'ethers';
dotenv.config();

export function getConfig() {
  const chainConfig = getChainConfig(process.env.IPFS_SERVICE_URL || "");

  const schema = z.object({
    mongoUri: z.string().startsWith('mongodb://'),
    dbName: z.string().min(1),
    rpcUrls: z.record(z.string()),
    chains: z.record(z.any()),
    maxWorkers: z.number().int().positive(),
    runnerSleepMs: z.number().int().positive(),
    fullNode: z.boolean(),
    executorPrivateKey: z.string(),
    executorAddress: z.string(),
    othenticExecutorAddress: z.string(),
    maxMissingNextSimLimit: z.number().int().positive(),
    maxBlockRanges: z.record(z.number().int().positive()),
    buildTag: z.string(),
    commitHash: z.string(),
    apiOnly: z.boolean(),
    httpPort: z.number().int().positive(),
    aggregatorURL: z.string(),
    othenticFlow: z.boolean(),
    operatorAddress: z.string(),
  });

  const rpcUrls = Object.fromEntries(
    CHAINS.map(chain => [
      chain.id,
      process.env[`RPC_URL_${chain.id}`] || chainConfig[chain.id]?.rpcUrl || '',
    ]),
  ) as Record<number, string>;

  const chains = Object.fromEntries(
    CHAINS.map(chain => [chain.id, chain]),
  ) as Record<number, any>;

  const maxBlockRanges = Object.fromEntries(
    CHAINS.map(chain => [
      chain.id,
      parseInt(process.env[`MAX_BLOCK_RANGE_${chain.id}`] || '10000', 10),
    ]),
  ) as Record<number, number>;

  const buildTag = process.env.BUILD_TAG || 'unset';
  const commitHash = process.env.COMMIT_HASH || 'unset';

  let operatorAddress = '';
  try {
    const pk = (process.env.EXECUTOR_PRIVATE_KEY || '').trim();
    if (pk) {
      const w = new Wallet(pk as `0x${string}`);
      operatorAddress = w.address;
    }
  } catch {}
  if (!operatorAddress) {
    operatorAddress = process.env.EXECUTOR_ADDRESS || '';
  }

  const cfg = {
    mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017',
    dbName: process.env.DB_NAME || 'indexer',
    rpcUrls,
    chains,
    maxWorkers: parseInt(process.env.MAX_WORKERS || '4', 10),
    runnerSleepMs: parseInt(process.env.RUNNER_NODE_SLEEP || '60', 10) * 1000,
    fullNode: process.env.FULL_NODE === 'true',
    executorPrivateKey: process.env.EXECUTOR_PRIVATE_KEY || '',
    executorAddress: process.env.EXECUTOR_ADDRESS || '',
    othenticExecutorAddress: process.env.OTHENTIC_EXECUTOR_ADDRESS || '',
    othenticFlow: process.env.OTHENTIC_FLOW === 'true',
    maxMissingNextSimLimit: parseInt(process.env.MAX_MISSING_NEXT_SIM_LIMIT || '100', 10),
    maxBlockRanges,
    buildTag,
    commitHash,
    apiOnly: process.env.API_ONLY === 'true',
    httpPort: parseInt(process.env.HTTP_PORT || '8080', 10),
    aggregatorURL: process.env.AGGREGATOR_URL || 'http://localhost:8080',
    operatorAddress,
  } as const;
  return Object.freeze(schema.parse(cfg));
}