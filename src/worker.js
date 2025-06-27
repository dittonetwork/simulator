import { parentPort, workerData } from 'worker_threads';
import dotenv from 'dotenv';
dotenv.config();
import { Database } from './db.js';
import { getNextSimulationTime } from './parsers/cronParser.js';
import { Workflow } from './validators/metaValidator.js';
import { getWorkflowSDKService } from './integrations/workflowSDK.js';
import EventMonitor from './eventMonitor.js';

if (!workerData || !workerData.workflow) {
    throw new Error('workerData.workflow is required. Do not run worker.js directly.');
}

class WorkflowProcessor {
    constructor(workflow) {
        this.workflow = workflow;
        this.fullNode = process.env.FULL_NODE === 'true';
        this.db = new Database();
        this.workflowSDK = null;
        this.eventMonitor = new EventMonitor();
        this.workerId = Math.random().toString(36).substr(2, 4); // Random 4-char ID
    }

    log(message) {
        console.log(`[Worker-${this.workerId}] ${message}`);
    }

    error(message, error = null) {
        const errorMsg = error ? (error.message || error.toString()) : '';
        console.error(`[Worker-${this.workerId}] ${message}${errorMsg ? ': ' + errorMsg : ''}`);
    }

    async initializeSDK() {
        try {
            this.workflowSDK = getWorkflowSDKService();
        } catch (error) {
            this.error('Failed to initialize SDK', error);
            throw error;
        }
    }

    validateTriggers(triggers) {
        // Just validate triggers, no transformation needed
        triggers.forEach((trigger, idx) => {
            switch (trigger.type) {
                case 'cron':
                    if (!trigger.params?.schedule) {
                        this.log(`Warning: Cron trigger at index ${idx} missing schedule`);
                    }
                    break;
                case 'event':
                    if (!trigger.params?.signature) {
                        this.log(`Warning: Event trigger at index ${idx} missing signature`);
                    }
                    break;
                default:
                    this.log(`Warning: Unknown trigger type at index ${idx}: ${trigger.type}`);
            }
        });
    }

    async understandTrigger() {
        // Validate triggers (no parsing needed)
        const meta = this.workflow.meta;
        this.validateTriggers(meta.workflow.triggers);

        // Check event triggers if any exist
        const eventTriggers = meta.workflow.triggers.filter(trigger => trigger.type === 'event');
        if (eventTriggers.length > 0) {
            this.eventCheckResult = await this.eventMonitor.checkEventTriggers(this.workflow, this.db);

            // Show event checking details
            this.eventCheckResult.results.forEach((result, i) => {
                if (result.error) {
                    this.error(`Event trigger ${result.triggerIndex}: ${result.error}`);
                } else {
                    this.log(`Event trigger ${result.triggerIndex}: ${result.eventsFound} events found in blocks ${result.fromBlock || 'N/A'}-${result.toBlock || 'N/A'} (${result.blocksChecked} blocks checked)`);
                }
            });

            if (!this.eventCheckResult.hasEvents) {
                this.log(`No events found - workflow skipped`);
                return false; // Stop processing here
            } else {
                this.log(`Events found! Proceeding with simulation`);
            }
        }

        return true;
    }

    async simulate() {
        try {
            if (!this.workflowSDK) {
                throw new Error('WorkflowSDK not initialized');
            }

            let simulationResult;

            // Check if workflow data is already in meta field (from MongoDB)
            if (this.workflow.meta && this.workflow.meta.sessions) {
                simulationResult = await this.workflowSDK.simulateWorkflow(
                    this.workflow.meta,
                    this.workflow.ipfs_hash
                );
            } else {
                // Load from IPFS and simulate
                const workflowData = await this.workflowSDK.loadWorkflowData(this.workflow.ipfs_hash);
                simulationResult = await this.workflowSDK.simulateWorkflow(
                    workflowData,
                    this.workflow.ipfs_hash
                );

                // Store the workflow data in meta for future use
                this.workflow.meta = workflowData;
            }

            // Check simulation result for AA23 validation error
            if (!simulationResult.success && simulationResult.error) {
                const mockError = { message: simulationResult.error };
                if (this.isAA23ValidationError(mockError)) {
                    this.log(`Detected AA23 validation error in simulation - marking workflow as cancelled`);
                    await this.markWorkflowCancelled(mockError);
                    return {
                        success: false,
                        error: this.getErrorSummary(mockError),
                        cancelled: true,
                        results: []
                    };
                }
            }

            return simulationResult;

        } catch (error) {
            this.error('Simulation failed', error);

            // Create error response with concise error message
            const errorMessage = this.getErrorSummary(error);

            // Check if this is the specific AA23 error that should cancel the workflow
            if (this.isAA23ValidationError(error)) {
                this.log(`Detected AA23 validation error during simulation - marking workflow as cancelled`);
                await this.markWorkflowCancelled(error);
                return {
                    success: false,
                    error: errorMessage,
                    cancelled: true,
                    results: []
                };
            }

            // For other errors, just record them but don't cancel
            return {
                success: false,
                error: errorMessage,
                results: []
            };
        }
    }

    async execute(simulationResult) {
        if (!simulationResult.success) {
            return { success: false, skipped: true, reason: 'simulation_failed' };
        }

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

            // Check execution result for AA23 validation error
            if (!executionResult.success && executionResult.error) {
                const mockError = { message: executionResult.error };
                if (this.isAA23ValidationError(mockError)) {
                    this.log(`Detected AA23 validation error in execution - marking workflow as cancelled`);
                    await this.markWorkflowCancelled(mockError);
                    return {
                        success: false,
                        error: this.getErrorSummary(mockError),
                        cancelled: true,
                        results: []
                    };
                }
            }

            return executionResult;
        } catch (error) {
            this.error('Execution failed', error);

            // Create error response with concise error message
            const errorMessage = this.getErrorSummary(error);

            // Check if this is the specific AA23 error that should cancel the workflow
            if (this.isAA23ValidationError(error)) {
                this.log(`Detected AA23 validation error - marking workflow as cancelled`);
                await this.markWorkflowCancelled(error);
                return {
                    success: false,
                    error: errorMessage,
                    cancelled: true,
                    results: []
                };
            }

            // For other errors, just record them but don't cancel
            return {
                success: false,
                error: errorMessage,
                results: []
            };
        }
    }

    /**
 * Create a concise error summary for storage
 */
    getErrorSummary(error) {
        const errorMessage = error.message || error.toString();

        // Check for specific known errors and create concise summaries
        if (errorMessage.includes('AA23 reverted')) {
            if (errorMessage.includes('0xc48cf8ee')) {
                return 'AA23 validation error: Contract rejected markRun call (0xc48cf8ee)';
            }
            return 'AA23 validation error: Account abstraction validation failed';
        }

        if (errorMessage.includes('AA21')) {
            return 'AA21 error: Insufficient funds for gas fees';
        }

        if (errorMessage.includes('AA22')) {
            return 'AA22 error: Signature expired or not due';
        }

        if (errorMessage.includes('AA24')) {
            return 'AA24 error: Invalid signature format';
        }

        if (errorMessage.includes('AA25')) {
            return 'AA25 error: Invalid account nonce';
        }

        if (errorMessage.includes('WorkflowSDK not initialized')) {
            return 'SDK initialization error';
        }

        if (errorMessage.includes('Failed to load workflow')) {
            return 'IPFS loading error';
        }

        // For other errors, truncate to reasonable length
        const maxLength = 200;
        return errorMessage.length > maxLength ?
            errorMessage.substring(0, maxLength) + '...' :
            errorMessage;
    }

    /**
     * Check if error is the specific AA23 validation error that should cancel workflows
     */
    isAA23ValidationError(error) {
        const errorMessage = error.message || error.toString();
        const hasAA23 = errorMessage.includes('AA23 reverted');
        const hasSpecificCode = errorMessage.includes('0xc48cf8ee');

        if (hasAA23 && hasSpecificCode) {
            this.log(`Detected cancellation-worthy AA23 error: 0xc48cf8ee`);
        }

        return hasAA23 && hasSpecificCode;
    }

    /**
     * Store last simulation result for debugging and tracking
     */
    async storeLastSimulationResult(simulationResult, executionResult) {
        try {
            const lastSimulation = {
                timestamp: new Date(),
                simulation: {
                    success: simulationResult ? simulationResult.success : false,
                    error: simulationResult?.error || null,
                    cancelled: simulationResult?.cancelled || false
                },
                execution: executionResult ? {
                    success: executionResult.success,
                    error: executionResult.error || null,
                    cancelled: executionResult.cancelled || false,
                    skipped: executionResult.skipped || false
                } : null
            };

            // Debug: Log what we're storing
            this.log(`Storing simulation result - Success: ${lastSimulation.simulation.success}, Error: ${lastSimulation.simulation.error || 'null'}, Cancelled: ${lastSimulation.simulation.cancelled}`);
            if (lastSimulation.execution) {
                this.log(`Storing execution result - Success: ${lastSimulation.execution.success}, Error: ${lastSimulation.execution.error || 'null'}, Cancelled: ${lastSimulation.execution.cancelled}`);
            }

            await this.db.withTransaction(async (session) => {
                await this.db.updateWorkflow(this.workflow.ipfs_hash, { last_simulation: lastSimulation }, session);
            });

        } catch (dbError) {
            this.error('Failed to store last simulation result', dbError);
        }
    }

    /**
     * Mark workflow as cancelled in database with validation details
     */
    async markWorkflowCancelled(error) {
        try {
            const updateData = {
                is_cancelled: true,
                validation_details: {
                    error_type: 'AA23_VALIDATION_ERROR',
                    error_code: '0xc48cf8ee',
                    error_message: error.message || error.toString(),
                    cancelled_at: new Date(),
                    reason: 'ERC-4337 validation failed'
                }
            };

            await this.db.withTransaction(async (session) => {
                await this.db.updateWorkflow(this.workflow.ipfs_hash, updateData, session);
            });

            this.log(`Workflow marked as cancelled due to AA23 validation error (0xc48cf8ee)`);
        } catch (dbError) {
            this.error('Failed to mark workflow as cancelled', dbError);
        }
    }

    async report(simulationResult, executionResult = null, triggerResult = null) {
        this.log(`Reporting for workflow ${this.workflow.getIpfsHashShort()}`);

        // Report event trigger results if any
        if (triggerResult && this.eventCheckResult) {
            this.log(`Event Triggers:`);
            this.eventCheckResult.results.forEach((result, i) => {
                if (result.error) {
                    this.log(`  Trigger ${result.triggerIndex} "${result.signature}": ERROR - ${result.error}`);
                } else {
                    this.log(`  Trigger ${result.triggerIndex} "${result.signature}": ${result.eventsFound} events found in ${result.blocksChecked} blocks`);
                }
            });

            if (!this.eventCheckResult.hasEvents) {
                this.log(`Overall: NO EVENTS TRIGGERED - workflow skipped`);
                return true;
            }
        }

        if (simulationResult && simulationResult.cancelled) {
            this.log(`Simulation: CANCELLED (AA23 validation error)`);
        } else {
            this.log(`Simulation: ${simulationResult ? (simulationResult.success ? 'SUCCESS' : 'FAILED') : 'SKIPPED'}`);
        }

        if (executionResult) {
            if (executionResult.cancelled) {
                this.log(`Execution: CANCELLED (AA23 validation error)`);
            } else {
                this.log(`Execution: ${executionResult.success ? 'SUCCESS' : 'FAILED'}`);
            }

            if (executionResult.success && executionResult.results) {
                executionResult.results.forEach((result, i) => {
                    if (result.userOpHash) {
                        this.log(`  Session ${i + 1} UserOp: ${result.userOpHash}`);
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
            this.log(`Workflow ${workflowObj.getIpfsHashShort()} validated successfully`);
        } catch (e) {
            this.error('Workflow validation failed', e);
            await this.db.close();
            throw e;
        }

        // Use workflowObj for all further processing
        this.workflow = workflowObj;

        // Initialize the WorkflowSDK
        await this.initializeSDK();

        const triggerResult = await this.understandTrigger();

        let simulationResult = null;
        let executionResult = null;

        // Only proceed if triggers are satisfied
        if (triggerResult) {
            // Real simulation using WorkflowSDK
            simulationResult = await this.simulate();

            // Check if simulation was cancelled due to AA23 error
            if (simulationResult && simulationResult.cancelled) {
                this.log(`Simulation was cancelled - stopping workflow processing`);
                await this.report(simulationResult, null, triggerResult);

                // Don't reschedule cancelled workflows
                this.log(`Workflow cancelled during simulation - not rescheduling`);
                await this.db.close();
                return;
            }

            // Execute only if we're a full node and simulation was successful
            if (this.fullNode && simulationResult.success) {
                executionResult = await this.execute(simulationResult);
            } else if (this.fullNode) {
                this.log(`Skipping execution due to failed simulation`);
            } else {
                this.log(`Skipping execution - not a full node`);
            }
        } else {
            this.log(`Skipping simulation and execution - event triggers not satisfied`);
        }

        await this.report(simulationResult, executionResult, triggerResult);

        // Don't reschedule if workflow was cancelled
        if (executionResult && executionResult.cancelled) {
            this.log(`Workflow cancelled - not rescheduling`);
            await this.db.close();
            return;
        }

        // Store last simulation result for tracking
        await this.storeLastSimulationResult(simulationResult, executionResult);

        // Calculate next simulation time - always use cron schedule
        const nextTime = getNextSimulationTime(this.workflow.triggers);

        if (nextTime) {
            // If execution was successful, add 1 minute delay for indexer catch-up
            let adjustedNextTime = nextTime;
            if (executionResult && executionResult.success && !executionResult.skipped) {
                adjustedNextTime = new Date(nextTime.getTime() + 60 * 1000); // Add 1 minute
                this.log(`Workflow executed successfully - adding 1-minute delay for indexer catch-up`);
                this.log(`Original next_simulation_time: ${nextTime.toISOString()}`);
                this.log(`Adjusted next_simulation_time: ${adjustedNextTime.toISOString()}`);
                this.log(`This prevents double execution while blockchain state is being indexed`);
            } else {
                const reason = !executionResult ? 'no execution' :
                    executionResult.skipped ? 'execution skipped' : 'execution failed';
                this.log(`No indexer delay needed (${reason}) - using normal schedule`);
                this.log(`Next_simulation_time for workflow ${this.workflow.getIpfsHashShort()}: ${nextTime.toISOString()}`);
            }

            try {
                await this.db.withTransaction(async (session) => {
                    await this.db.updateWorkflow(this.workflow.ipfs_hash, { next_simulation_time: adjustedNextTime }, session);
                });
                this.log(`Transaction committed for workflow ${this.workflow.getIpfsHashShort()}`);
            } catch (e) {
                this.error(`Transaction failed for workflow ${this.workflow.getIpfsHashShort()}`, e);
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
        // Create worker ID for error logging
        const workerId = Math.random().toString(36).substr(2, 4);
        console.error(`[Worker-${workerId}] Processing failed: ${e.message || e.toString()}`);
        parentPort.postMessage({ error: e.message });
    }
})();