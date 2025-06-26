import {
    Workflow,
    ChainId,
    DEFAULT_CHAIN_CONFIGS,
    IpfsStorage,
    WorkflowContract
} from '@ditto/workflow-sdk';
import { Hex } from 'viem';

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
            config.rpcUrl
        );
    }

    /**
     * Load workflow data from IPFS hash
     */
    async loadWorkflowFromIpfs(ipfsHash: string): Promise<SerializedWorkflowData> {
        console.log(`[WorkflowSDK] Loading workflow data from IPFS: ${ipfsHash}`);
        try {
            const workflowData = await Workflow.loadFromIpfs(ipfsHash, this.storage);
            console.log(`[WorkflowSDK] Successfully loaded workflow data`);
            console.log(`[WorkflowSDK] - Sessions: ${workflowData.sessions.length}`);
            console.log(`[WorkflowSDK] - Owner: ${workflowData.workflow.owner}`);
            console.log(`[WorkflowSDK] - Jobs: ${workflowData.workflow.jobs.length}`);
            return workflowData;
        } catch (error) {
            console.error(`[WorkflowSDK] Failed to load workflow from IPFS:`, error);
            throw error;
        }
    }

    /**
     * Simulate workflow execution using stored workflow data
     */
    async simulateWorkflow(
        workflowData: SerializedWorkflowData,
        ipfsHash: string
    ): Promise<SimulationResult> {
        console.log(`[WorkflowSDK] Simulating workflow execution for ${ipfsHash}`);
        try {
            const result = await Workflow.executeFromData(
                workflowData,
                ipfsHash,
                this.config.executorPrivateKey,
                this.config.rpcUrl,
                this.workflowContract,
                true // simulate = true
            );

            console.log(`[WorkflowSDK] Simulation completed successfully`);
            console.log(`[WorkflowSDK] - Success: ${result.success}`);
            console.log(`[WorkflowSDK] - Sessions: ${result.results.length}`);

            // Log gas estimates
            result.results.forEach((res: any, i: number) => {
                if (res.gas) {
                    console.log(`[WorkflowSDK] - Session ${i + 1} gas estimate: ${res.gas.amount} USDC`);
                }
            });

            return result;
        } catch (error) {
            console.error(`[WorkflowSDK] Simulation failed:`, error);
            throw error;
        }
    }

    /**
     * Execute workflow using stored workflow data
     */
    async executeWorkflow(
        workflowData: SerializedWorkflowData,
        ipfsHash: string
    ): Promise<ExecutionResult> {
        console.log(`[WorkflowSDK] Executing workflow for ${ipfsHash}`);
        try {
            const result = await Workflow.executeFromData(
                workflowData,
                ipfsHash,
                this.config.executorPrivateKey,
                this.config.rpcUrl,
                this.workflowContract,
                false // simulate = false
            );

            console.log(`[WorkflowSDK] Execution completed successfully`);
            console.log(`[WorkflowSDK] - Success: ${result.success}`);
            console.log(`[WorkflowSDK] - Sessions: ${result.results.length}`);

            // Log transaction hashes
            result.results.forEach((res: any, i: number) => {
                if (res.userOpHash) {
                    console.log(`[WorkflowSDK] - Session ${i + 1} UserOp: ${res.userOpHash}`);
                }
            });

            if (result.markRunHash) {
                console.log(`[WorkflowSDK] - MarkRun called: ${result.markRunHash}`);
            }

            return result;
        } catch (error) {
            console.error(`[WorkflowSDK] Execution failed:`, error);
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
        console.log(`[WorkflowSDK] Starting full workflow processing for ${ipfsHash}`);

        // Step 1: Load workflow data
        const workflowData = await this.loadWorkflowFromIpfs(ipfsHash);

        // Step 2: Simulate
        const simulationResult = await this.simulateWorkflow(workflowData, ipfsHash);

        let executionResult: ExecutionResult | undefined;

        // Step 3: Execute if simulation was successful
        if (simulationResult.success) {
            console.log(`[WorkflowSDK] Simulation successful, proceeding with execution`);
            executionResult = await this.executeWorkflow(workflowData, ipfsHash);
        } else {
            console.warn(`[WorkflowSDK] Simulation failed, skipping execution`);
        }

        return {
            workflowData,
            simulationResult,
            executionResult
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
        chainId: parseInt(process.env.CHAIN_ID || '11155111', 10) // Default to Sepolia
    };
} 