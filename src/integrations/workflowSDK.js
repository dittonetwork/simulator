import { createWorkflowSDK, getDefaultConfig } from '../../dist/integrations/workflowSDK.js';

/**
 * JavaScript wrapper for the WorkflowSDK integration
 * This provides a simple interface for the simulator to use the workflow SDK
 */
export class WorkflowSDKService {
    constructor(config = null) {
        this.config = config || getDefaultConfig();
        this.sdk = createWorkflowSDK(this.config);

        console.log('[WorkflowSDKService] Initialized with config:');
        console.log(`  - Chain ID: ${this.config.chainId}`);
        console.log(`  - RPC URL: ${this.config.rpcUrl}`);
        console.log(`  - IPFS Service: ${this.config.ipfsServiceUrl}`);
        console.log(`  - Contract: ${this.config.workflowContractAddress}`);
        console.log(`  - Executor: ${this.config.executorPrivateKey.substring(0, 10)}...`);
    }

    /**
     * Load workflow data from IPFS hash
     */
    async loadWorkflowData(ipfsHash) {
        try {
            console.log(`[WorkflowSDKService] Loading workflow data for: ${this.getShortHash(ipfsHash)}`);
            const workflowData = await this.sdk.loadWorkflowFromIpfs(ipfsHash);
            console.log(`[WorkflowSDKService] Successfully loaded workflow data`);
            return workflowData;
        } catch (error) {
            console.error(`[WorkflowSDKService] Failed to load workflow data:`, error);
            throw error;
        }
    }

    /**
     * Simulate workflow execution
     */
    async simulateWorkflow(workflowData, ipfsHash) {
        try {
            console.log(`[WorkflowSDKService] Simulating workflow: ${this.getShortHash(ipfsHash)}`);
            const result = await this.sdk.simulateWorkflow(workflowData, ipfsHash);
            console.log(`[WorkflowSDKService] Simulation result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
            return result;
        } catch (error) {
            console.error(`[WorkflowSDKService] Simulation failed:`, error);
            throw error;
        }
    }

    /**
     * Execute workflow
     */
    async executeWorkflow(workflowData, ipfsHash) {
        try {
            console.log(`[WorkflowSDKService] Executing workflow: ${this.getShortHash(ipfsHash)}`);
            const result = await this.sdk.executeWorkflow(workflowData, ipfsHash);
            console.log(`[WorkflowSDKService] Execution result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
            return result;
        } catch (error) {
            console.error(`[WorkflowSDKService] Execution failed:`, error);
            throw error;
        }
    }

    /**
     * Full workflow processing: Load -> Simulate -> Execute
     */
    async processWorkflow(ipfsHash) {
        try {
            console.log(`[WorkflowSDKService] Starting full processing for: ${this.getShortHash(ipfsHash)}`);
            const result = await this.sdk.processWorkflow(ipfsHash);

            console.log(`[WorkflowSDKService] Processing completed:`);
            console.log(`  - Simulation: ${result.simulationResult.success ? 'SUCCESS' : 'FAILED'}`);
            console.log(`  - Execution: ${result.executionResult ? (result.executionResult.success ? 'SUCCESS' : 'FAILED') : 'SKIPPED'}`);

            return result;
        } catch (error) {
            console.error(`[WorkflowSDKService] Processing failed:`, error);
            throw error;
        }
    }

    /**
     * Utility method to get short hash for logging
     */
    getShortHash(ipfsHash) {
        if (!ipfsHash || ipfsHash.length <= 8) return ipfsHash;
        return `${ipfsHash.slice(0, 4)}...${ipfsHash.slice(-4)}`;
    }

    /**
     * Validate configuration
     */
    validateConfig() {
        const required = ['executorPrivateKey', 'rpcUrl', 'workflowContractAddress'];
        const missing = required.filter(key => !this.config[key]);

        if (missing.length > 0) {
            throw new Error(`Missing required configuration: ${missing.join(', ')}`);
        }

        console.log('[WorkflowSDKService] Configuration validation passed');
        return true;
    }
}

/**
 * Factory function to create a WorkflowSDK service instance
 */
export function createWorkflowSDKService(customConfig = null) {
    const service = new WorkflowSDKService(customConfig);
    service.validateConfig();
    return service;
}

/**
 * Singleton instance for global use
 */
let globalInstance = null;

export function getWorkflowSDKService(customConfig = null) {
    if (!globalInstance || customConfig) {
        globalInstance = createWorkflowSDKService(customConfig);
    }
    return globalInstance;
} 