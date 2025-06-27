import { createWorkflowSDK, getDefaultConfig } from '../../dist/integrations/workflowSDK.js';

/**
 * JavaScript wrapper for the WorkflowSDK integration
 * This provides a simple interface for the simulator to use the workflow SDK
 */
export class WorkflowSDKService {
    constructor(config = null) {
        this.config = config || getDefaultConfig();
        this.sdk = createWorkflowSDK(this.config);
    }

    /**
     * Load workflow data from IPFS hash
     */
    async loadWorkflowData(ipfsHash) {
        try {
            const workflowData = await this.sdk.loadWorkflowFromIpfs(ipfsHash);
            return workflowData;
        } catch (error) {
            console.error(`[WorkflowSDKService] Failed to load workflow data:`, error.message);
            throw error;
        }
    }

    /**
     * Simulate workflow execution
     */
    async simulateWorkflow(workflowData, ipfsHash) {
        try {
            const result = await this.sdk.simulateWorkflow(workflowData, ipfsHash);

            // Extract error from session results if simulation failed
            if (!result.success && result.results && result.results.length > 0) {
                const firstError = result.results.find(r => r.error);
                if (firstError && firstError.error) {
                    result.error = firstError.error;
                }
            }

            console.log(`[WorkflowSDKService] Simulation: ${result.success ? 'SUCCESS' : 'FAILED'}`);
            return result;
        } catch (error) {
            console.error(`[WorkflowSDKService] Simulation failed:`, error.message);
            throw error;
        }
    }

    /**
     * Execute workflow
     */
    async executeWorkflow(workflowData, ipfsHash) {
        try {
            const result = await this.sdk.executeWorkflow(workflowData, ipfsHash);

            // Extract error from session results if execution failed
            if (!result.success && result.results && result.results.length > 0) {
                const firstError = result.results.find(r => r.error);
                if (firstError && firstError.error) {
                    result.error = firstError.error;
                }
            }

            console.log(`[WorkflowSDKService] Execution: ${result.success ? 'SUCCESS' : 'FAILED'}`);
            return result;
        } catch (error) {
            console.error(`[WorkflowSDKService] Execution failed:`, error.message);
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