import { createPublicClient, http, parseAbiItem } from 'viem';
import { getConfig } from './config.js';
import { getLogger } from './logger.js';
import { OnchainTrigger, Workflow } from "@ditto/workflow-sdk";

/**
 * Result for a single on-chain trigger check
 */
export interface OnchainTriggerCheck {
  triggerIndex: number;
  chainId: number;
  success: boolean;
  result?: any;
  error?: string;
  blockNumber?: number;
}

export interface OnchainCheckAggregate {
  allTrue: boolean;
  results: OnchainTriggerCheck[];
}

export default class OnchainChecker {
  private clients: Map<number, any> = new Map();
  private timeoutMs: number;
  private retries: number;
  private logger = getLogger('OnchainChecker');

  constructor() {
    const cfg = getConfig();
    Object.entries(cfg.chains).forEach(([chainIdStr, chainObj]) => {
      const chainId = Number(chainIdStr);
      const rpcUrl = (cfg.rpcUrls as Record<number, string>)[chainId];
      if (rpcUrl) {
        this.clients.set(chainId, createPublicClient({ chain: chainObj, transport: http(rpcUrl) }));
      }
    });

    this.timeoutMs = parseInt(process.env.ONCHAIN_TIMEOUT_MS || '5000', 10);
    this.retries = parseInt(process.env.ONCHAIN_RETRIES || '1', 10);
  }

  private async callWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('onchain call timeout')), this.timeoutMs)),
    ]) as Promise<T>;
  }

  async checkOnchainTriggers(workflow: Workflow | undefined): Promise<OnchainCheckAggregate> {
    if (!workflow) return { allTrue: true, results: [] };
    const triggers = (workflow.triggers || []).filter((t: any) => t.type === 'onchain') as OnchainTrigger[];
    if (triggers.length === 0) return { allTrue: true, results: [] };

    const results: OnchainTriggerCheck[] = [];
    let allTrue = true;

    for (const [idx, trigger] of triggers.entries()) {
      const chainId = trigger.params?.chainId;
      const client = this.clients.get(chainId);
      if (!client) {
        this.logger.error(`No RPC client for chain ${chainId}`);
        results.push({ triggerIndex: idx, chainId, success: false, error: `No RPC client for chain ${chainId}` });
        allTrue = false;
        continue;
      }

      let attempt = 0;
      let success = false;
      let resultVal: any = undefined;
      let errorMsg: string | undefined = undefined;

      const abiItem = parseAbiItem(`function ${trigger.params.abi} view returns (bool)`);
      const functionName = (abiItem as import('viem').AbiFunction).name;

      // Obtain the current block once and use it for a consistent read
      const currentBlockBigInt = await client.getBlockNumber();
      const currentBlockNumber = Number(currentBlockBigInt);

      while (attempt < this.retries && !success) {
        try {
          const res = await this.callWithTimeout(async () => client.readContract({
            address: trigger.params.target as `0x${string}`,
            abi: [abiItem],
            functionName: functionName as any,
            args: trigger.params.args,
            blockNumber: currentBlockBigInt,
          }));
          success = res === true;
          resultVal = res;
        } catch (e) {
          errorMsg = (e as Error).message;
          this.logger.error({ e }, `Onchain trigger ${idx} failed attempt ${attempt + 1}`);
        }
        attempt++;
      }

      if (!success) allTrue = false;
      results.push({ triggerIndex: idx, chainId, success, result: resultVal, error: errorMsg, blockNumber: currentBlockNumber });
    }

    return { allTrue, results };
  }
} 