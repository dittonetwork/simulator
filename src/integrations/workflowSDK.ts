import { 
  IpfsStorage, 
  Workflow, 
  WorkflowContract, 
  executeFromIpfs, 
  type SerializedWorkflowData,
  type DataRefContext,
  serializeDataRefContext,
  type WasmRefContext,
} from '@ditto/workflow-sdk';
import { createWasmClient } from '../utils/wasmClient.js';
import { Database } from '../db.js';
import { Wallet, JsonRpcProvider } from 'ethers';
import { getLogger } from '../logger.js';
import { deserialize } from '@ditto/workflow-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { addressToEmptyAccount } from '@zerodev/sdk';
import { Signer } from "@zerodev/sdk/types";

const logger = getLogger('WorkflowSDK');

export interface SimulationResult {
  success: boolean;
  results: Array<{
    success: boolean;
    userOpHash?: string;
    userOp?: any;
    gas?: {
      preVerificationGas: number;
      verificationGasLimit: number;
      callGasLimit: number;
      paymasterVerificationGasLimit?: number;
      paymasterPostOpGasLimit?: number;
      totalGasEstimate: number;
    };
    chainId: number;
    start: string;
    finish: string;
    error?: string;
  }>;
  markRunHash?: string;
  error?: string;
  /** 
   * DataRef context for deterministic consensus.
   * Contains block numbers used for read-calls - operators must use same blocks.
   */
  dataRefContext?: DataRefContext;
  /** Serialized dataRefContext for easy transmission */
  dataRefContextSerialized?: string;
}

export interface ExecutionResult {
  success: boolean;
  results: Array<{
    success: boolean;
    userOpHash?: string;
    userOp?: any;
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
  executorAddress: string;
  rpcUrl: string;
  ipfsServiceUrl: string;
  workflowContractAddress: string;
  chainId: number;
}

export class WorkflowSDKIntegration {
  private config: WorkflowSDKConfig;

  private storage: IpfsStorage;

  private workflowContract: WorkflowContract;

  private database: Database | null;

  constructor(config: WorkflowSDKConfig, database?: Database) {
    this.config = config;
    this.storage = new IpfsStorage(config.ipfsServiceUrl);
    this.workflowContract = new WorkflowContract(config.workflowContractAddress as `0x${string}`);
    this.database = database || null;
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
      logger.error({ error: error }, 'Failed to load workflow from IPFS');
      throw error;
    }
  }

  /**
   * Simulate workflow execution using stored workflow data
   * 
   * Returns dataRefContext with block numbers for deterministic consensus.
   * Pass this context to operators so they can reproduce the same read-calls.
   */
  async simulateWorkflow(
    _workflowData: Workflow,
    ipfsHash: string,
    prodContract: boolean,
    ipfsServiceUrl: string,
    accessToken?: string,
  ): Promise<SimulationResult> {
    logger.info(`Simulating workflow execution for ${ipfsHash}`);
    try {
      let executor: Signer;
      if (this.config.executorAddress != "") {
        logger.info(`Using executor address: ${this.config.executorAddress}`);
        executor = addressToEmptyAccount(this.config.executorAddress as `0x${string}`);
      } else if (this.config.executorPrivateKey != "") {
        executor = privateKeyToAccount(this.config.executorPrivateKey as `0x${string}`);
      } else {
        throw new Error('Executor address or private key is not defined in environment variables');
      }

      // Create WASM client if available
      const wasmClient = createWasmClient();
      
      // Ensure database is connected for WASM module lookup
      let db: Database | undefined;
      if (this.database) {
        await this.database.connect();
        db = this.database;
      }
      
      const result = await executeFromIpfs(
        ipfsHash,
        this.storage,
        executor,
        prodContract,
        ipfsServiceUrl,
        true,
        false,
        accessToken,
        undefined, // dataRefContext - will be created
        wasmClient || undefined,
        db,
        undefined, // wasmRefContext - will be created
      );

      logger.info(`Simulation completed successfully`);
      logger.info(`- Success: ${result.success}`);
      logger.info(`- Sessions: ${result.results.length}`);
      
      // Log DataRef context if present
      if (result.dataRefContext && result.dataRefContext.resolvedRefs.length > 0) {
        logger.info(`- DataRef context: ${result.dataRefContext.resolvedRefs.length} resolved refs`);
        Object.entries(result.dataRefContext.chainBlocks).forEach(([chainId, block]) => {
          logger.info(`  Chain ${chainId}: block ${block}`);
        });
      }

      // Log gas estimates
      result.results.forEach((res: any, i: number) => {
        if (res.gas) {
          logger.info(
            `- Session ${i + 1} gas estimate:`,
            `preVerificationGas: ${res.gas.preVerificationGas},`,
            `verificationGasLimit: ${res.gas.verificationGasLimit},`,
            `callGasLimit: ${res.gas.callGasLimit}`
          );
        }
        if (res.userOp) {
            logger.info(`- Session ${i + 1} userOp:`, res.userOp);
        }
      });

      // Build simulation result with dataRefContext
      const simResult: SimulationResult = {
        success: result.success,
        results: result.results as any,
        markRunHash: result.markRunHash,
        dataRefContext: result.dataRefContext,
      };
      
      // Add serialized context for easy transmission to operators
      if (result.dataRefContext && result.dataRefContext.resolvedRefs.length > 0) {
        simResult.dataRefContextSerialized = serializeDataRefContext(result.dataRefContext);
      }

      return simResult;
    } catch (error) {
      logger.error({ error: error }, 'Simulation failed');
      throw error;
    }
  }

  /**
   * Execute workflow using stored workflow data
   */
  async executeWorkflow(
    _workflowData: Workflow,
    ipfsHash: string,
    prodContract: boolean,
    ipfsServiceUrl: string,
    accessToken?: string,
  ): Promise<ExecutionResult> {
    logger.info(`Executing workflow for ${ipfsHash}`);
    try {
      const executor = privateKeyToAccount(this.config.executorPrivateKey as `0x${string}`);
      
      // Create WASM client if available
      const wasmClient = createWasmClient();
      
      // Ensure database is connected for WASM module lookup
      let db: Database | undefined;
      if (this.database) {
        await this.database.connect();
        db = this.database;
      }
      
      const result = await executeFromIpfs(
        ipfsHash,
        this.storage,
        executor,
        prodContract,
        ipfsServiceUrl,
        false,
        false,
        accessToken,
        undefined, // dataRefContext
        wasmClient || undefined,
        db,
        undefined, // wasmRefContext
      );

      logger.info(`Execution completed successfully`);
      logger.info(`- Success: ${result.success}`);
      logger.info(`- Sessions: ${result.results.length}`);

      // Log transaction hashes
      result.results.forEach((res: any, i: number) => {
        if (res.userOpHash) {
          logger.info(`- Session ${i + 1} UserOpHash: ${res.userOpHash}`);
        }
        if (res.userOp) {
            logger.info(`- Session ${i + 1} userOp:`, res.userOp);
        }
      });

      const markHash = (result as any).markRunHash;
      if (markHash) {
        logger.info(`- MarkRun called: ${markHash}`);
      }

      return result as ExecutionResult;
    } catch (error) {
      logger.error({ error: error }, 'Execution failed');
      throw error;
    }
  }

  /**
   * Combined flow: Load from IPFS, simulate, then execute
   */
  async processWorkflow(
    ipfsHash: string,
    prodContract: boolean,
    ipfsServiceUrl: string,
    accessToken?: string,
  ): Promise<{
    workflowData: Workflow;
    simulationResult: SimulationResult;
    executionResult?: ExecutionResult;
  }> {
    logger.info(`Starting full workflow processing for ${ipfsHash}`);

    // Step 1: Load workflow data
    const workflowData = await this.loadWorkflowFromIpfs(ipfsHash);

    // Step 2: Simulate
    const simulationResult = await this.simulateWorkflow(
      workflowData,
      ipfsHash,
      prodContract,
      ipfsServiceUrl,
      accessToken,
    );

    let executionResult: ExecutionResult | undefined;

    // Step 3: Execute if simulation was successful
    if (simulationResult.success) {
      logger.info(`Simulation successful, proceeding with execution`);
      executionResult = await this.executeWorkflow(
        workflowData,
        ipfsHash,
        prodContract,
        ipfsServiceUrl,
        accessToken,
      );
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
    executorAddress: process.env.EXECUTOR_ADDRESS || '',
    rpcUrl: process.env.RPC_URL || '',
    ipfsServiceUrl: process.env.IPFS_SERVICE_URL || 'http://206.189.3.20:8081/ipfs',
    workflowContractAddress: process.env.WORKFLOW_CONTRACT_ADDRESS || '',
    chainId: parseInt(process.env.CHAIN_ID || '11155111', 10), // Default to Sepolia
  };
}

// === Added compatibility layer that existed in previous JavaScript wrapper ===
export class WorkflowSDKService {
  private integration: WorkflowSDKIntegration;

  constructor(config: Partial<WorkflowSDKConfig> = {}, database?: Database) {
    const mergedConfig: WorkflowSDKConfig = {
      executorPrivateKey: config.executorPrivateKey || process.env.EXECUTOR_PRIVATE_KEY || '',
      executorAddress: config.executorAddress || process.env.EXECUTOR_ADDRESS || '',
      rpcUrl: config.rpcUrl || process.env.RPC_URL || '',
      ipfsServiceUrl: config.ipfsServiceUrl || process.env.IPFS_SERVICE_URL || 'http://206.189.3.20:8081/ipfs',
      workflowContractAddress: config.workflowContractAddress || process.env.WORKFLOW_CONTRACT_ADDRESS || '',
      chainId: config.chainId || parseInt(process.env.CHAIN_ID || '11155111', 10),
    } as WorkflowSDKConfig;

    this.integration = new WorkflowSDKIntegration(mergedConfig, database);
  }

  loadWorkflowData(ipfsHash: string) {
    return this.integration.loadWorkflowFromIpfs(ipfsHash);
  }

  simulateWorkflow(
    data: Workflow,
    ipfsHash: string,
    prodContract: boolean,
    ipfsServiceUrl: string,
    accessToken?: string,
  ) {
    return this.integration.simulateWorkflow(data, ipfsHash, prodContract, ipfsServiceUrl, accessToken);
  }

  executeWorkflow(
    data: Workflow,
    ipfsHash: string,
    prodContract: boolean,
    ipfsServiceUrl: string,
    accessToken?: string,
  ) {
    return this.integration.executeWorkflow(data, ipfsHash, prodContract, ipfsServiceUrl, accessToken);
  }

  processWorkflow(ipfsHash: string, prodContract: boolean, ipfsServiceUrl: string) {
    return this.integration.processWorkflow(ipfsHash, prodContract, ipfsServiceUrl);
  }
}

export function createWorkflowSDKService(config?: Partial<WorkflowSDKConfig>, database?: Database) {
  return new WorkflowSDKService(config, database);
}

let _globalInstance: WorkflowSDKService | null = null;

export function getWorkflowSDKService(config?: Partial<WorkflowSDKConfig>, database?: Database) {
  if (!_globalInstance || config || database) {
    _globalInstance = createWorkflowSDKService(config, database);
  }
  return _globalInstance;
}
