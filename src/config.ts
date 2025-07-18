import dotenv from 'dotenv';
import { z } from 'zod';
import { sepolia, mainnet } from 'viem/chains';
import { CHAIN_IDS } from './constants.js';

dotenv.config();

export function getConfig() {
  const schema = z.object({
    mongoUri: z.string().url(),
    dbName: z.string().min(1),
    rpcUrls: z.object({
      [CHAIN_IDS.SEPOLIA]: z.string().url(),
      [CHAIN_IDS.MAINNET]: z.string().url().optional(),
    }),
    chains: z.object({
      [CHAIN_IDS.SEPOLIA]: z.any(),
      [CHAIN_IDS.MAINNET]: z.any(),
    }),
    maxWorkers: z.number().int().positive(),
    runnerSleepMs: z.number().int().positive(),
    fullNode: z.boolean(),
    maxMissingNextSimLimit: z.number().int().positive(),
    maxBlockRanges: z.object({
      [CHAIN_IDS.SEPOLIA]: z.number().int().positive(),
      [CHAIN_IDS.MAINNET]: z.number().int().positive(),
    }),
  });

  const cfg = {
    mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017',
    dbName: process.env.DB_NAME || 'indexer',
    rpcUrls: {
      [CHAIN_IDS.SEPOLIA]: process.env.RPC_URL || 'https://rpc.ankr.com/eth_sepolia',
      ...(process.env.MAINNET_RPC_URL ? { [CHAIN_IDS.MAINNET]: process.env.MAINNET_RPC_URL } : {})
    } as Record<number, string>,
    chains: {
      [CHAIN_IDS.SEPOLIA]: sepolia,
      [CHAIN_IDS.MAINNET]: mainnet,
    },
    maxWorkers: parseInt(process.env.MAX_WORKERS || '4', 10),
    runnerSleepMs: parseInt(process.env.RUNNER_NODE_SLEEP || '60', 10) * 1000,
    fullNode: process.env.FULL_NODE === 'true',
    maxMissingNextSimLimit: parseInt(process.env.MAX_MISSING_NEXT_SIM_LIMIT || '100', 10),
    maxBlockRanges: {
      [CHAIN_IDS.SEPOLIA]: parseInt(process.env.MAX_BLOCK_RANGE_11155111 || '10000', 10),
      [CHAIN_IDS.MAINNET]: parseInt(process.env.MAX_BLOCK_RANGE_1 || '2000', 10),
    },
  } as const;

  return Object.freeze(schema.parse(cfg));
}
