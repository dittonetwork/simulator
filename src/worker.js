import { parentPort, workerData } from 'worker_threads';
import dotenv from 'dotenv';
dotenv.config();
import cronParser from 'cron-parser';
import { Database } from './db.js';
import { parseCronConfig, getNextSimulationTime } from './parsers/cronParser.js';
import { parseEventConfig } from './parsers/eventParser.js';
import { Workflow } from './validators/metaValidator.js';
import { getWorkflowSDKService } from './integrations/workflowSDK.js';

if (!workerData || !workerData.workflow) {
    throw new Error('workerData.workflow is required. Do not run worker.js directly.');
}

class WorkflowProcessor {
    constructor(workflow) {
        this.workflow = workflow;
        this.fullNode = process.env.FULL_NODE === 'true';
        this.db = new Database();
        this.workflowSDK = null;
    }

    async initializeSDK() {
        try {
            this.workflowSDK = getWorkflowSDKService();
            console.log(`[WorkflowSDK] Initialized SDK for workflow ${this.workflow.getIpfsHashShort()}`);
        } catch (error) {
            console.error(`[WorkflowSDK] Failed to initialize SDK:`, error);
            throw error;
        }
    }

    parseTriggers(triggers) {
        return triggers.map((cfg, idx) => {
            try {
                switch (cfg.type) {
                    case 'cron':
                        const parsedCron = parseCronConfig(cfg);
                        console.debug(`[Parser] Parsed cron config at index ${idx}:`, parsedCron);
                        return parsedCron;
                    case 'event':
                        const parsedEvent = parseEventConfig(cfg);
                        console.debug(`[Parser] Parsed event config at index ${idx}:`, parsedEvent.signature);
                        return parsedEvent;
                    default:
                        console.warn(`[Parser] Unknown trigger type at index ${idx}:`, cfg);
                        return { type: 'unknown', raw: cfg };
                }
            } catch (e) {
                console.error(`[Parser] Error parsing trigger at index ${idx}:`, e.message);
                return { type: 'invalid', error: e.message, raw: cfg };
            }
        });
    }

    async understandTrigger() {
        // Parse and log each trigger item (new format only)
        const meta = this.workflow.meta;
        this.parseTriggers(meta.workflow.triggers);
        console.log(`[Step] Understanding trigger for workflow ${this.workflow.getIpfsHashShort()}`);
        return true;
    }

    async simulate() {
        console.log(`[Step] Real simulation starting for workflow ${this.workflow.getIpfsHashShort()}`);

        try {
            if (!this.workflowSDK) {
                throw new Error('WorkflowSDK not initialized');
            }

            // Check if workflow data is already in meta field (from MongoDB)
            if (this.workflow.meta && this.workflow.meta.sessions) {
                console.log(`[Step] Using workflow data from meta field`);
                const simulationResult = await this.workflowSDK.simulateWorkflow(
                    this.workflow.meta,
                    this.workflow.ipfs_hash
                );
                return simulationResult;
            } else {
                // Load from IPFS and simulate
                console.log(`[Step] Loading workflow data from IPFS before simulation`);
                const workflowData = await this.workflowSDK.loadWorkflowData(this.workflow.ipfs_hash);
                const simulationResult = await this.workflowSDK.simulateWorkflow(
                    workflowData,
                    this.workflow.ipfs_hash
                );

                // Store the workflow data in meta for future use
                this.workflow.meta = workflowData;

                return simulationResult;
            }
        } catch (error) {
            console.error(`[Step] Simulation failed for workflow ${this.workflow.getIpfsHashShort()}:`, error);
            return {
                success: false,
                error: error.message,
                results: []
            };
        }
    }

    async execute(simulationResult) {
        if (!simulationResult.success) {
            console.log(`[Step] Skipping execution for workflow ${this.workflow.getIpfsHashShort()} due to failed simulation`);
            return { success: false, skipped: true, reason: 'simulation_failed' };
        }

        console.log(`[Step] Real execution starting for workflow ${this.workflow.getIpfsHashShort()}`);

        try {
            if (!this.workflowSDK) {
                throw new Error('WorkflowSDK not initialized');
            }

            // Use stored workflow data from meta
            if (!this.workflow.meta || !this.workflow.meta.sessions) {
                throw new Error('Workflow data not available in meta field');
            }

            const executionResult = await this.workflowSDK.executeWorkflow(
                this.workflow.meta,
                this.workflow.ipfs_hash
            );

            return executionResult;
        } catch (error) {
            console.error(`[Step] Execution failed for workflow ${this.workflow.getIpfsHashShort()}:`, error);
            return {
                success: false,
                error: error.message,
                results: []
            };
        }
    }

    async report(simulationResult, executionResult = null) {
        console.log(`[Step] Reporting for workflow ${this.workflow.getIpfsHashShort()}`);
        console.log(`  Simulation: ${simulationResult.success ? 'SUCCESS' : 'FAILED'}`);
        if (executionResult) {
            console.log(`  Execution: ${executionResult.success ? 'SUCCESS' : 'FAILED'}`);

            if (executionResult.success && executionResult.results) {
                executionResult.results.forEach((result, i) => {
                    if (result.userOpHash) {
                        console.log(`    Session ${i + 1} UserOp: ${result.userOpHash}`);
                    }
                });
            }
        }
        return true;
    }


    async process() {
        await this.db.connect();
        let workflowObj;

        try {
            workflowObj = new Workflow(this.workflow);
            console.log(`[Validator] Workflow ${workflowObj.getIpfsHashShort()} validated successfully.`);
        } catch (e) {
            console.error(`[Validator] Workflow validation failed:`, e.message);
            await this.db.close();
            throw e;
        }

        // Use workflowObj for all further processing
        this.workflow = workflowObj;

        // Initialize the WorkflowSDK
        await this.initializeSDK();

        await this.understandTrigger();

        // Real simulation using WorkflowSDK
        const simulationResult = await this.simulate();

        let executionResult = null;

        // Execute only if we're a full node and simulation was successful
        if (this.fullNode && simulationResult.success) {
            executionResult = await this.execute(simulationResult);
        } else if (this.fullNode) {
            console.log(`[Step] Skipping execution due to failed simulation`);
        } else {
            console.log(`[Step] Skipping execution - not a full node`);
        }

        await this.report(simulationResult, executionResult);

        // Calculate next simulation time
        const nextTime = getNextSimulationTime(this.workflow.triggers);
        if (nextTime) {
            // If execution was successful, add 1 minute delay for indexer catch-up
            let adjustedNextTime = nextTime;
            if (executionResult && executionResult.success && !executionResult.skipped) {
                adjustedNextTime = new Date(nextTime.getTime() + 60 * 1000); // Add 1 minute
                console.log(`[Indexer] Workflow executed successfully - adding 1-minute delay for indexer catch-up`);
                console.log(`[Cron] Original next_simulation_time: ${nextTime.toISOString()}`);
                console.log(`[Cron] Adjusted next_simulation_time: ${adjustedNextTime.toISOString()}`);
                console.log(`[Indexer] This prevents double execution while blockchain state is being indexed`);
            } else {
                const reason = !executionResult ? 'no execution' :
                    executionResult.skipped ? 'execution skipped' : 'execution failed';
                console.log(`[Cron] No indexer delay needed (${reason}) - using normal schedule`);
                console.log(`[Cron] Next_simulation_time for workflow ${this.workflow.getIpfsHashShort()}: ${nextTime.toISOString()}`);
            }

            try {
                await this.db.withTransaction(async (session) => {
                    await this.db.updateWorkflow(this.workflow.ipfs_hash, { next_simulation_time: adjustedNextTime }, session);
                });
                console.log(`[DB] Transaction committed for workflow ${this.workflow.getIpfsHashShort()}`);
            } catch (e) {
                console.error(`[DB] Transaction failed for workflow ${this.workflow.getIpfsHashShort()}:`, e);
            }
        }

        await this.db.close();
    }
}

// Entry point for worker thread
(async () => {
    if (!workerData || !workerData.workflow) {
        throw new Error('workerData.workflow is required. Do not run worker.js directly.');
    }

    const processor = new WorkflowProcessor(workerData.workflow);
    try {
        await processor.process();
        parentPort.postMessage({ success: true });
    } catch (e) {
        console.error(`[Worker] Processing failed:`, e);
        parentPort.postMessage({ error: e.message });
    }
})();