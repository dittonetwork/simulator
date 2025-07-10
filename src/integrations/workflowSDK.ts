import * as WF from '../../ditto-workflow-sdk/src/index.ts';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { Signer } from '@zerodev/sdk/types';

type SerializedWorkflowData = WF.SerializedWorkflowData;

type ResultItem = {
  success: boolean;
  userOpHash?: string;
  gas?: { amount: number };
  error?: string;
};

export type SimulationResult = {
  success: boolean;
  results: ResultItem[];
  markRunHash?: string;
  error?: string;
};

export type ExecutionResult = {
  success: boolean;
  results: ResultItem[];
  markRunHash?: string;
  error?: string;
};

export interface WorkflowSDKConfig {
  executorPrivateKey: Hex | string;
  ipfsServiceUrl: string;
}

export class WorkflowSDKService {
  private storage: WF.IpfsStorage;

  private executorAccount: Signer;

  constructor(config: Partial<WorkflowSDKConfig> = {}) {
    const executorKey = (config.executorPrivateKey || process.env.EXECUTOR_PRIVATE_KEY || '') as Hex;
    const ipfsUrl = config.ipfsServiceUrl || process.env.IPFS_SERVICE_URL || 'http://206.189.3.20:8081/ipfs';
    this.storage = new WF.IpfsStorage(ipfsUrl);
    this.executorAccount = privateKeyToAccount(executorKey);
  }

  async loadWorkflowData(ipfsHash: string): Promise<SerializedWorkflowData> {
    return this.storage.download(ipfsHash);
  }

  private mapResults(results: any[]): ResultItem[] {
    return results.map((r) => ({
      success: r.success,
      userOpHash: r.userOpHash ? String(r.userOpHash) : undefined,
      gas: r.gas ? { amount: Number(r.gas.amount) } : undefined,
      error: r.error,
    }));
  }

  async simulateWorkflow(data: SerializedWorkflowData, ipfsHash: string): Promise<SimulationResult> {
    const workflow = await WF.deserialize(data);
    const res = await WF.execute(workflow, this.executorAccount, ipfsHash, BigInt(0), true);
    return { success: res.success, results: this.mapResults(res.results) };
  }

  async executeWorkflow(data: SerializedWorkflowData, ipfsHash: string): Promise<ExecutionResult> {
    const workflow = await WF.deserialize(data);
    const res = await WF.execute(workflow, this.executorAccount, ipfsHash, BigInt(0), false);
    return { success: res.success, results: this.mapResults(res.results) };
  }
}

export function createWorkflowSDKService(config?: Partial<WorkflowSDKConfig>) {
  return new WorkflowSDKService(config);
}

let _instance: WorkflowSDKService | null = null;

export function getWorkflowSDKService(config?: Partial<WorkflowSDKConfig>) {
  if (!_instance || config) _instance = createWorkflowSDKService(config);
  return _instance;
}

export type { SerializedWorkflowData };
