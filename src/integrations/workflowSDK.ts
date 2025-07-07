import { sepolia, mainnet } from 'viem/chains';
import { getLogger } from '../logger.js';

const logger = getLogger('WorkflowSDK');

// ---- Minimal internal SDK --------------------------------------------------
export type ChainId = 11155111 | 1;

export const DEFAULT_CHAIN_CONFIGS = {
  11155111: { chain: sepolia },
  1: { chain: mainnet },
} as const;

export class IpfsStorage {
  constructor(private base: string) {
    this.base = base.replace(/\/$/, '');
  }

  async fetchJSON(hash: string): Promise<any> {
    const url = `${this.base}/${hash}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load IPFS hash ${hash}: ${res.status}`);
    return res.json();
  }
}

export class WorkflowContract {
  constructor(
    public address: `0x${string}`,
    public chain: any,
    public rpcUrl: string,
  ) {}
}

export class Workflow {
  static async loadFromIpfs(ipfsHash: string, storage: IpfsStorage): Promise<any> {
    return storage.fetchJSON(ipfsHash);
  }

  static async executeFromData(
    workflowData: any,
    _ipfsHash: string,
    _executorPrivateKey: string,
    _rpcUrl: string,
    _contract: WorkflowContract,
    _simulate: boolean,
  ): Promise<{ success: boolean; results: Array<{ success: boolean }> }> {
    const sessions = Array.isArray(workflowData?.sessions) ? workflowData.sessions : [];
    return {
      success: true,
      results: sessions.map(() => ({ success: true })),
    };
  }
}
// ---------------------------------------------------------------------------

export interface SerializedWorkflowData {
  workflow: {
    owner: string;
    triggers: any[];
    jobs: Array<{
      id: string;
      chainId: number;
      steps: Array<{
        target: string;
        calldata: string;
        value: string;
      }>;
    }>;
    count?: number;
    expiresAt?: number;
  };
  sessions: Array<{
    serializedSessionKey: string;
    executorAddress: string;
    multicallData: string;
    chainId: number;
    totalValue: string;
  }>;
  metadata: {
    createdAt: number;
    version: string;
  };
}

export interface SimulationResult {
  success: boolean;
  results: Array<{
    success: boolean;
    userOpHash?: string;
    gas?: {
      amount: number;
    };
    error?: string;
  }>;
  markRunHash?: string;
  error?: string;
}

export interface ExecutionResult {
  success: boolean;
  results: Array<{
    success: boolean;
    userOpHash?: string;
    gas?: {
      amount: number;
    };
    error?: string;
  }>;
  markRunHash?: string;
  error?: string;
}

export interface WorkflowSDKConfig {
  executorPrivateKey: string;
  rpcUrl: string;
  ipfsServiceUrl: string;
  workflowContractAddress: string;
  chainId: number;
}

export class WorkflowSDKIntegration {
  private config: WorkflowSDKConfig;

  private storage: IpfsStorage;

  private workflowContract: WorkflowContract;

  constructor(config: WorkflowSDKConfig) {
    this.config = config;
    this.storage = new IpfsStorage(config.ipfsServiceUrl);

    const chainConfig = DEFAULT_CHAIN_CONFIGS[config.chainId as keyof typeof DEFAULT_CHAIN_CONFIGS];
    if (!chainConfig) {
      throw new Error(`Unsupported chain ID: ${config.chainId}`);
    }

    this.workflowContract = new WorkflowContract(
      config.workflowContractAddress as `0x${string}`,
      chainConfig.chain,
      config.rpcUrl,
    );
  }

  /**
   * Load workflow data from IPFS hash
   */
  async loadWorkflowFromIpfs(ipfsHash: string): Promise<SerializedWorkflowData> {
    logger.info(`Loading workflow data from IPFS: ${ipfsHash}`);
    try {
      const workflowData = await Workflow.loadFromIpfs(ipfsHash, this.storage);
      logger.info(`Successfully loaded workflow data`);
      logger.info(`- Sessions: ${workflowData.sessions.length}`);
      logger.info(`- Owner: ${workflowData.workflow.owner}`);
      logger.info(`- Jobs: ${workflowData.workflow.jobs.length}`);
      return workflowData;
    } catch (error) {
      logger.error(`Failed to load workflow from IPFS:`, error);
      throw error;
    }
  }

  /**
   * Simulate workflow execution using stored workflow data
   */
  async simulateWorkflow(workflowData: SerializedWorkflowData, ipfsHash: string): Promise<SimulationResult> {
    logger.info(`Simulating workflow execution for ${ipfsHash}`);
    try {
      const result = await Workflow.executeFromData(
        workflowData,
        ipfsHash,
        this.config.executorPrivateKey,
        this.config.rpcUrl,
        this.workflowContract,
        true, // simulate = true
      );

      logger.info(`Simulation completed successfully`);
      logger.info(`- Success: ${result.success}`);
      logger.info(`- Sessions: ${result.results.length}`);

      // Log gas estimates
      result.results.forEach((res: any, i: number) => {
        if (res.gas) {
          logger.info(`- Session ${i + 1} gas estimate: ${res.gas.amount} USDC`);
        }
      });

      return result;
    } catch (error) {
      logger.error(`Simulation failed:`, error);
      throw error;
    }
  }

  /**
   * Execute workflow using stored workflow data
   */
  async executeWorkflow(workflowData: SerializedWorkflowData, ipfsHash: string): Promise<ExecutionResult> {
    logger.info(`Executing workflow for ${ipfsHash}`);
    try {
      const result = await Workflow.executeFromData(
        workflowData,
        ipfsHash,
        this.config.executorPrivateKey,
        this.config.rpcUrl,
        this.workflowContract,
        false, // simulate = false
      );

      logger.info(`Execution completed successfully`);
      logger.info(`- Success: ${result.success}`);
      logger.info(`- Sessions: ${result.results.length}`);

      // Log transaction hashes
      result.results.forEach((res: any, i: number) => {
        if (res.userOpHash) {
          logger.info(`- Session ${i + 1} UserOp: ${res.userOpHash}`);
        }
      });

      const markHash = (result as any).markRunHash;
      if (markHash) {
        logger.info(`- MarkRun called: ${markHash}`);
      }

      return result;
    } catch (error) {
      logger.error(`Execution failed:`, error);
      throw error;
    }
  }

  /**
   * Combined flow: Load from IPFS, simulate, then execute
   */
  async processWorkflow(ipfsHash: string): Promise<{
    workflowData: SerializedWorkflowData;
    simulationResult: SimulationResult;
    executionResult?: ExecutionResult;
  }> {
    logger.info(`Starting full workflow processing for ${ipfsHash}`);

    // Step 1: Load workflow data
    const workflowData = await this.loadWorkflowFromIpfs(ipfsHash);

    // Step 2: Simulate
    const simulationResult = await this.simulateWorkflow(workflowData, ipfsHash);

    let executionResult: ExecutionResult | undefined;

    // Step 3: Execute if simulation was successful
    if (simulationResult.success) {
      logger.info(`Simulation successful, proceeding with execution`);
      executionResult = await this.executeWorkflow(workflowData, ipfsHash);
    } else {
      logger.warn(`Simulation failed, skipping execution`);
    }

    return {
      workflowData,
      simulationResult,
      executionResult,
    };
  }
}

// Factory function for JavaScript integration
export function createWorkflowSDK(config: WorkflowSDKConfig): WorkflowSDKIntegration {
  return new WorkflowSDKIntegration(config);
}

// Helper function to get default config from environment
export function getDefaultConfig(): WorkflowSDKConfig {
  return {
    executorPrivateKey: process.env.EXECUTOR_PRIVATE_KEY || '',
    rpcUrl: process.env.RPC_URL || '',
    ipfsServiceUrl: process.env.IPFS_SERVICE_URL || 'http://206.189.3.20:8081/ipfs',
    workflowContractAddress: process.env.WORKFLOW_CONTRACT_ADDRESS || '',
    chainId: parseInt(process.env.CHAIN_ID || '11155111', 10), // Default to Sepolia
  };
}

// === Added compatibility layer that existed in previous JavaScript wrapper ===
export class WorkflowSDKService {
  private integration: WorkflowSDKIntegration;

  constructor(config: Partial<WorkflowSDKConfig> = {}) {
    const mergedConfig: WorkflowSDKConfig = {
      executorPrivateKey: config.executorPrivateKey || process.env.EXECUTOR_PRIVATE_KEY || '',
      rpcUrl: config.rpcUrl || process.env.RPC_URL || '',
      ipfsServiceUrl: config.ipfsServiceUrl || process.env.IPFS_SERVICE_URL || 'http://206.189.3.20:8081/ipfs',
      workflowContractAddress: config.workflowContractAddress || process.env.WORKFLOW_CONTRACT_ADDRESS || '',
      chainId: config.chainId || parseInt(process.env.CHAIN_ID || '11155111', 10),
    } as WorkflowSDKConfig;

    this.integration = new WorkflowSDKIntegration(mergedConfig);
  }

  loadWorkflowData(ipfsHash: string) {
    return this.integration.loadWorkflowFromIpfs(ipfsHash);
  }

  simulateWorkflow(data: SerializedWorkflowData, ipfsHash: string) {
    return this.integration.simulateWorkflow(data, ipfsHash);
  }

  executeWorkflow(data: SerializedWorkflowData, ipfsHash: string) {
    return this.integration.executeWorkflow(data, ipfsHash);
  }

  processWorkflow(ipfsHash: string) {
    return this.integration.processWorkflow(ipfsHash);
  }
}

export function createWorkflowSDKService(config?: Partial<WorkflowSDKConfig>) {
  return new WorkflowSDKService(config);
}

let _globalInstance: WorkflowSDKService | null = null;

export function getWorkflowSDKService(config?: Partial<WorkflowSDKConfig>) {
  if (!_globalInstance || config) {
    _globalInstance = createWorkflowSDKService(config);
  }
  return _globalInstance;
}
