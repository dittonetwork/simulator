import { IpfsStorage, Workflow, WorkflowContract, executeFromIpfs, type SerializedWorkflowData } from '@ditto/workflow-sdk';
import { Wallet, JsonRpcProvider } from 'ethers';
import { getLogger } from '../logger.js';
import { deserialize } from '@ditto/workflow-sdk';

const logger = getLogger('WorkflowSDK');

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

    this.workflowContract = new WorkflowContract(config.workflowContractAddress as `0x${string}`);
  }

  /**
   * Load workflow data from IPFS hash
   */
  async loadWorkflowFromIpfs(ipfsHash: string): Promise<Workflow> {
    logger.info(`Loading workflow data from IPFS: ${ipfsHash}`);
    try {
      const workflowData = await deserialize(await this.storage.download(ipfsHash));
      logger.info(`Successfully loaded workflow data`);
      logger.info(`- Owner: ${workflowData.owner}`);
      logger.info(`- Jobs: ${workflowData.jobs.length}`);

      return workflowData;
    } catch (error) {
      logger.error(`Failed to load workflow from IPFS:`, error);
      throw error;
    }
  }

  /**
   * Simulate workflow execution using stored workflow data
   */
  async simulateWorkflow(_workflowData: Workflow, ipfsHash: string): Promise<SimulationResult> {
    logger.info(`Simulating workflow execution for ${ipfsHash}`);
    try {
      const executor = new Wallet(this.config.executorPrivateKey, new JsonRpcProvider(this.config.rpcUrl));
      const result = await executeFromIpfs(
        ipfsHash,
        this.storage,
        executor as any,
        BigInt(0),
        true,
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

      return result as SimulationResult;
    } catch (error) {
      logger.error(`Simulation failed:`, error);
      throw error;
    }
  }

  /**
   * Execute workflow using stored workflow data
   */
  async executeWorkflow(_workflowData: Workflow, ipfsHash: string): Promise<ExecutionResult> {
    logger.info(`Executing workflow for ${ipfsHash}`);
    try {
      const executor = new Wallet(this.config.executorPrivateKey, new JsonRpcProvider(this.config.rpcUrl));
      const result = await executeFromIpfs(
        ipfsHash,
        this.storage,
        executor as any,
        BigInt(0),
        false,
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

      return result as ExecutionResult;
    } catch (error) {
      logger.error(`Execution failed:`, error);
      throw error;
    }
  }

  /**
   * Combined flow: Load from IPFS, simulate, then execute
   */
  async processWorkflow(ipfsHash: string): Promise<{
    workflowData: Workflow;
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

  simulateWorkflow(data: Workflow, ipfsHash: string) {
    return this.integration.simulateWorkflow(data, ipfsHash);
  }

  executeWorkflow(data: Workflow, ipfsHash: string) {
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
