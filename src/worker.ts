import { parentPort, workerData } from 'worker_threads';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import type { Logger } from 'pino';
import { Database } from './db.js';
import { getNextSimulationTime } from './parsers/cronParser.js';
import { Workflow } from './validators/metaValidator.js';
import type { WorkflowDocument } from './interfaces.js';
import { getWorkflowSDKService } from './integrations/workflowSDK.js';
import type { WorkflowSDKService } from './integrations/workflowSDK.js';
import EventMonitor from './eventMonitor.js';
import { getLogger } from './logger.js';
import { TRIGGER_TYPE } from './constants.js';
import { Trigger, CronTriggerParams, EventTriggerParams, SerializedWorkflowData } from '@ditto/workflow-sdk';

dotenv.config();

class WorkflowProcessor {
  private workflow: Workflow;

  private fullNode: boolean;

  private db: Database;

  private workflowSDK: WorkflowSDKService | null;

  private eventMonitor: EventMonitor;

  private workerId: string;

  private logger: Logger;

  private eventCheckResult: boolean | { hasEvents: boolean; results: any[] } | null;

  private static readonly ERROR_PATTERNS = [
    { regex: /AA23 reverted.*0xc48cf8ee/, summary: 'AA23 validation error: Contract rejected markRun call (0xc48cf8ee)' },
    { regex: /AA23/, summary: 'AA23 validation error' },
    { regex: /AA21/, summary: 'AA21 error: Insufficient funds for gas fees' },
    { regex: /AA22/, summary: 'AA22 error: Signature expired or not due' },
    { regex: /AA24/, summary: 'AA24 error: Invalid signature format' },
    { regex: /AA25/, summary: 'AA25 error: Invalid account nonce' },
    { regex: /WorkflowSDK not initialized/, summary: 'SDK initialization error' },
    { regex: /Failed to load workflow/, summary: 'IPFS loading error' },
  ];

  constructor(workflow: WorkflowDocument) {
    this.workflow = workflow as unknown as Workflow;
    this.fullNode = process.env.FULL_NODE === 'true';
    this.db = new Database();
    this.workflowSDK = null;
    this.eventMonitor = new EventMonitor();
    this.workerId = uuidv4();
    this.logger = getLogger(`Worker-${this.workerId}`);
    this.eventCheckResult = null;
  }

  log(message: string): void {
    this.logger.info(message);
  }

  error(message: string, error: unknown = null): void {
    const err = error as Error | null;
    const errorMsg = err ? err.message || err.toString() : '';
    this.logger.error(message, { error: errorMsg });
  }

  async initializeSDK() {
    try {
      this.workflowSDK = getWorkflowSDKService();
    } catch (error) {
      this.error('Failed to initialize SDK', error);
      throw error;
    }
  }

  validateTriggers(triggers: Trigger[]): void {
    triggers.forEach((trigger, idx) => {
      switch (trigger.type) {
        case TRIGGER_TYPE.CRON: {
          const params = trigger.params as CronTriggerParams;
          if (!params.schedule) {
            this.log(`Warning: Cron trigger at index ${idx} missing schedule`);
          }
          break;
        }
        case TRIGGER_TYPE.EVENT: {
          const params = trigger.params as EventTriggerParams;
          if (!params.signature) {
            this.log(`Warning: Event trigger at index ${idx} missing signature`);
          }
          break;
        }
        default:
          this.log(`Warning: Unknown trigger type at index ${idx}: ${(trigger as any).type}`);
      }
    });
  }

  async understandTrigger() {
    // Validate triggers (no parsing needed)
    const { meta } = this.workflow;
    if (!meta) return false;
    this.validateTriggers(meta.triggers);

    // Check event triggers if any exist
    const eventTriggers = meta.triggers.filter((trigger) => trigger.type === TRIGGER_TYPE.EVENT);
    if (eventTriggers.length > 0) {
      this.eventCheckResult = await this.eventMonitor.checkEventTriggers(this.workflow, this.db);

      // Show event checking details
      if (typeof this.eventCheckResult !== 'boolean' && this.eventCheckResult?.results) {
        this.eventCheckResult.results.forEach((result) => {
          if (result.error) {
            this.error(`Event trigger ${result.triggerIndex}: ${result.error}`);
          } else {
            this.log(
              `Event trigger ${result.triggerIndex}: ${result.eventsFound} events found in blocks ${result.fromBlock || 'N/A'}-${result.toBlock || 'N/A'} (${result.blocksChecked} blocks checked)`,
            );
          }
        });
      }

      if (typeof this.eventCheckResult !== 'boolean' && !this.eventCheckResult.hasEvents) {
        this.log(`No events found - workflow skipped`);
        return false; // Stop processing here
      }
      this.log(`Events found! Proceeding with simulation`);
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
      if (this.workflow.meta) {
        simulationResult = await this.workflowSDK.simulateWorkflow(
          this.workflow.meta,
          this.workflow.ipfs_hash,
        );
      } else {
        // Load from IPFS and simulate
        const workflowData = await this.workflowSDK.loadWorkflowData(this.workflow.ipfs_hash);
        simulationResult = await this.workflowSDK.simulateWorkflow(
          workflowData,
          this.workflow.ipfs_hash,
        );

        // Store the workflow data in meta for future use
        this.workflow.meta = workflowData;
      }

      // Check simulation result for AA23 validation error
      if (!simulationResult.success && simulationResult.error) {
        const mockError = { message: simulationResult.error };
        if (this.shouldCancelWorkflow(mockError)) {
          this.log(`Detected AA23 validation error in simulation - marking workflow as cancelled`);
          await this.markWorkflowCancelled(mockError);
          return {
            success: false,
            error: this.getErrorSummary(mockError),
            cancelled: true,
            results: [],
          };
        }
      }

      return simulationResult;
    } catch (error) {
      this.error('Simulation failed', error);

      // Create error response with concise error message
      const errorMessage = this.getErrorSummary(error);

      // Check if this is the specific AA23 error that should cancel the workflow
      if (this.shouldCancelWorkflow(error)) {
        this.log(`Detected AA23 validation error during simulation - marking workflow as cancelled`);
        await this.markWorkflowCancelled(error);
        return {
          success: false,
          error: errorMessage,
          cancelled: true,
          results: [],
        };
      }

      // For other errors, just record them but don't cancel
      return {
        success: false,
        error: errorMessage,
        results: [],
      };
    }
  }

  async execute(simulationResult: any): Promise<any> {
    if (!simulationResult.success) {
      return { success: false, skipped: true, reason: 'simulation_failed' };
    }

    try {
      if (!this.workflowSDK) {
        throw new Error('WorkflowSDK not initialized');
      }

      // Use stored workflow data from meta
      if (!this.workflow.meta) {
        throw new Error('Workflow data not available in meta field');
      }

      const executionResult = await this.workflowSDK.executeWorkflow(
        this.workflow.meta,
        this.workflow.ipfs_hash,
      );

      // Check execution result for AA23 validation error
      if (!executionResult.success && executionResult.error) {
        const mockError = { message: executionResult.error };
        if (this.shouldCancelWorkflow(mockError)) {
          this.log(`Detected AA23 validation error in execution - marking workflow as cancelled`);
          await this.markWorkflowCancelled(mockError);
          return {
            success: false,
            error: this.getErrorSummary(mockError),
            cancelled: true,
            results: [],
          };
        }
      }

      return executionResult;
    } catch (error) {
      this.error('Execution failed', error);

      // Create error response with concise error message
      const errorMessage = this.getErrorSummary(error);

      // Check if this is the specific AA23 error that should cancel the workflow
      if (this.shouldCancelWorkflow(error)) {
        this.log(`Detected AA23 validation error - marking workflow as cancelled`);
        await this.markWorkflowCancelled(error);
        return {
          success: false,
          error: errorMessage,
          cancelled: true,
          results: [],
        };
      }

      // For other errors, just record them but don't cancel
      return {
        success: false,
        error: errorMessage,
        results: [],
      };
    }
  }

  /**
   * Create a concise error summary for storage
   */
  getErrorSummary(error: any) {
    const message = error.message || error.toString();
    for (const p of WorkflowProcessor.ERROR_PATTERNS) {
      if (p.regex.test(message)) return p.summary;
    }
    const maxLen = 200;
    return message.length > maxLen ? `${message.slice(0, maxLen)}...` : message;
  }

  shouldCancelWorkflow(error: any) {
    const msg = error.message || error.toString();
    const isAA23 = msg.includes('AA23 reverted') && msg.includes('0xc48cf8ee');
    if (isAA23) this.log('Detected cancellation-worthy AA23 error');
    return isAA23;
  }

  /**
   * Store last simulation result for debugging and tracking
   */
  async storeLastSimulationResult(simulationResult: any, executionResult: any): Promise<void> {
    try {
      const lastSimulation = {
        timestamp: new Date(),
        simulation: {
          success: simulationResult ? simulationResult.success : false,
          error: simulationResult?.error || null,
          cancelled: simulationResult?.cancelled || false,
        },
        execution: executionResult
          ? {
              success: executionResult.success,
              error: executionResult.error || null,
              cancelled: executionResult.cancelled || false,
              skipped: executionResult.skipped || false,
            }
          : null,
      };

      // Debug: Log what we're storing
      this.log(
        `Storing simulation result - Success: ${lastSimulation.simulation.success}, Error: ${lastSimulation.simulation.error || 'null'}, Cancelled: ${lastSimulation.simulation.cancelled}`,
      );
      if (lastSimulation.execution) {
        this.log(
          `Storing execution result - Success: ${lastSimulation.execution.success}, Error: ${lastSimulation.execution.error || 'null'}, Cancelled: ${lastSimulation.execution.cancelled}`,
        );
      }

      await this.db.updateWorkflow(this.workflow.ipfs_hash, { last_simulation: lastSimulation });
    } catch (dbError) {
      this.error('Failed to store last simulation result', dbError);
    }
  }

  /**
   * Mark workflow as cancelled in database with validation details
   */
  async markWorkflowCancelled(error: any) {
    try {
      const updateData = {
        is_cancelled: true,
        validation_details: {
          error_type: 'AA23_VALIDATION_ERROR',
          error_code: '0xc48cf8ee',
          error_message: error.message || error.toString(),
          cancelled_at: new Date(),
          reason: 'ERC-4337 validation failed',
        },
      };

      await this.db.updateWorkflow(this.workflow.ipfs_hash, updateData);

      this.log(`Workflow marked as cancelled due to AA23 validation error (0xc48cf8ee)`);
    } catch (dbError) {
      this.error('Failed to mark workflow as cancelled', dbError);
    }
  }

  async report(simulationResult: any, executionResult: any = null, triggerResult: any = null): Promise<boolean> {
    this.log(`Reporting for workflow ${this.workflow.getIpfsHashShort()}`);

    // Report event trigger results if any
    if (triggerResult && this.eventCheckResult && typeof this.eventCheckResult !== 'boolean') {
      this.log(`Event Triggers:`);
      this.eventCheckResult.results.forEach((result) => {
        if (result.error) {
          this.log(`  Trigger ${result.triggerIndex} "${result.signature}": ERROR - ${result.error}`);
        } else {
          this.log(
            `  Trigger ${result.triggerIndex} "${result.signature}": ${result.eventsFound} events found in ${result.blocksChecked} blocks`,
          );
        }
      });

      if (!this.eventCheckResult.hasEvents) {
        this.log(`Overall: NO EVENTS TRIGGERED - workflow skipped`);
        return true;
      }
    }

    if (simulationResult && (simulationResult as any).cancelled) {
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
        executionResult.results.forEach((result: any, idx: number) => {
          if (result.userOpHash) {
            this.log(`  Session ${idx + 1} UserOp: ${result.userOpHash}`);
          }
        });
      }
    }
    return true;
  }

  private async handleWorkflow() {
    const triggerSatisfied = await this.understandTrigger();

    let simulationResult = null;
    let executionResult = null;

    if (triggerSatisfied) {
      simulationResult = await this.simulate();

      if (simulationResult && (simulationResult as any).cancelled) {
        await this.report(simulationResult, null, triggerSatisfied);
        return { simulationResult, executionResult, cancelled: true };
      }

      if (this.fullNode && simulationResult.success) {
        executionResult = await this.execute(simulationResult);
      }
    }

    await this.report(simulationResult, executionResult, triggerSatisfied);

    return { simulationResult, executionResult, cancelled: (executionResult as any)?.cancelled || false };
  }

  private async scheduleNextRun(_simulationResult: any, executionResult: any): Promise<void> {
    const nextTime = getNextSimulationTime(this.workflow.triggers);
    if (!nextTime) return;

    let adjusted = nextTime;
    if (executionResult && executionResult.success && !executionResult.skipped) {
      adjusted = new Date(nextTime.getTime() + 60 * 1000);
    }

    await this.db.updateWorkflow(this.workflow.ipfs_hash, { next_simulation_time: adjusted });
  }

  async process() {
    await this.db.connect();

    try {
      const obj = new Workflow(this.workflow);
      this.workflow = obj;
      await this.initializeSDK();

      const { simulationResult, executionResult, cancelled } = await this.handleWorkflow();

      if (!cancelled) {
        await this.storeLastSimulationResult(simulationResult, executionResult);
        await this.scheduleNextRun(simulationResult, executionResult);
      }
    } finally {
      await this.db.close();
    }
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
    if (parentPort) parentPort.postMessage({ success: true });
  } catch (e) {
    const err = e as Error;
    getLogger('Worker').error('Processing failed', { error: err.message || err.toString() });
    if (parentPort) parentPort.postMessage({ error: err.message });
  }
})();
