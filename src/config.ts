import dotenv from 'dotenv';
import { z } from 'zod';

import { getChainConfig, CHAINS } from '@ditto/workflow-sdk';
dotenv.config();

export function getConfig() {
  const chainConfig = getChainConfig();

  const schema = z.object({
    mongoUri: z.string().startsWith('mongodb://'),
    dbName: z.string().min(1),
    rpcUrls: z.record(z.string()),
    chains: z.record(z.any()),
    maxWorkers: z.number().int().positive(),
    runnerSleepMs: z.number().int().positive(),
    fullNode: z.boolean(),
    maxMissingNextSimLimit: z.number().int().positive(),
    maxBlockRanges: z.record(z.number().int().positive()),
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

  const cfg = {
    mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017',
    dbName: process.env.DB_NAME || 'indexer',
    rpcUrls,
    chains,
    maxWorkers: parseInt(process.env.MAX_WORKERS || '4', 10),
    runnerSleepMs: parseInt(process.env.RUNNER_NODE_SLEEP || '60', 10) * 1000,
    fullNode: process.env.FULL_NODE === 'true',
    maxMissingNextSimLimit: parseInt(process.env.MAX_MISSING_NEXT_SIM_LIMIT || '100', 10),
    maxBlockRanges,
  } as const;

  return Object.freeze(schema.parse(cfg));
}
