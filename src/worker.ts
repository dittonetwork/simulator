import { parentPort, workerData } from 'worker_threads';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import type { Logger } from 'pino';
import { Database } from './db.js';
import { getNextSimulationTime } from './parsers/cronParser.js';
import { Workflow } from './types/workflow.js';
import type { WorkflowDocument } from './types/interfaces.js';
import { getWorkflowSDKService } from './integrations/workflowSDK.js';
import type { WorkflowSDKService } from './integrations/workflowSDK.js';
import EventMonitor from './eventMonitor.js';
import OnchainChecker from './onchainChecker.js';
import { getLogger } from './logger.js';
import { TRIGGER_TYPE } from './constants.js';
import { Trigger, CronTriggerParams, EventTriggerParams, SerializedWorkflowData, Workflow as SDKWorkflow } from '@ditto/workflow-sdk';
import { reportingClient } from './reportingClient.js';
import { bigIntToString } from './utils.js';

dotenv.config();

class WorkflowProcessor {
  private workflow: Workflow;

  private fullNode: boolean;

  private db: Database;

  private workflowSDK: WorkflowSDKService | null;

  private eventMonitor: EventMonitor;

  private onchainChecker: OnchainChecker;

  private workerId: string;

  private logger: Logger;

  private eventCheckResult: boolean | { hasEvents: boolean; results: any[] } | null;

  private onchainCheckResult: { allTrue: boolean; results: any[] } | null;

  private zerodevApiKey: string;

  private isProd: boolean;

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
    this.onchainChecker = new OnchainChecker();
    this.workerId = uuidv4();
    this.logger = getLogger(`Worker-${this.workflow.ipfs_hash}-${this.workerId}`);
    this.eventCheckResult = null;
    this.onchainCheckResult = null;
    this.isProd = process.env.IS_PROD === 'true';
    this.zerodevApiKey = process.env.ZERODEV_API_KEY || '';
  }

  log(message: string): void {
    this.logger.info(message);
  }

  error(message: string, error: unknown = null): void {
    const err = error as Error | null;
    const errorMsg = err ? err.message || err.toString() : '';
    this.logger.error({ error: errorMsg }, message);
  }

  async initializeReportingClient(accessToken?: string, refreshToken?: string) {
    if (accessToken && refreshToken) {
      reportingClient.setTokens(accessToken, refreshToken);
    }
    await reportingClient.initialize();
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
    triggers.forEach((trigger: Trigger, idx: number) => {
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
        case TRIGGER_TYPE.ONCHAIN: {
          const params = (trigger as any).params;
          if (!params?.abi || !params?.target) {
            this.log(`Warning: Onchain trigger at index ${idx} missing abi or target`);
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
    this.validateTriggers(meta.workflow.triggers);

    // 1. Check on-chain triggers first (AND logic):
    const onchainTriggers = meta.workflow.triggers.filter((t: any) => t.type === TRIGGER_TYPE.ONCHAIN);
    if (onchainTriggers.length > 0) {
      this.onchainCheckResult = await this.onchainChecker.checkOnchainTriggers(this.workflow.meta?.workflow);

      // Log onchain checking details
      this.onchainCheckResult.results.forEach((res) => {
        if (res.error) {
          this.error(`Onchain trigger ${res.triggerIndex}: ${res.error}`);
        } else {
          this.log(`Onchain trigger ${res.triggerIndex}: ${res.success ? 'TRUE' : 'FALSE'} (block ${res.blockNumber || 'N/A'})`);
        }
      });

      if (!this.onchainCheckResult.allTrue) {
        this.log('Onchain trigger conditions not met - workflow skipped');
        return false; // Stop further processing
      }
      this.log('Onchain triggers satisfied! Proceeding to event triggers');
    }

    // 2. Check event triggers if any exist
    const eventTriggers = meta.workflow.triggers.filter((trigger: Trigger) => trigger.type === TRIGGER_TYPE.EVENT);
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
          this.workflow.meta.workflow,
          this.workflow.ipfs_hash,
          this.isProd,
          this.zerodevApiKey,
        );
      } else {
        // Load from IPFS and simulate
        const workflowData = await this.workflowSDK.loadWorkflowData(this.workflow.ipfs_hash);
        simulationResult = await this.workflowSDK.simulateWorkflow(
          workflowData,
          this.workflow.ipfs_hash,
          this.isProd,
          this.zerodevApiKey,
        );

        // Store the workflow data in meta for future use
        this.workflow.meta = {
          workflow: workflowData,
          metadata: {
            // Placeholder for metadata if needed
            createdAt: { $numberLong: Date.now().toString() },
            version: '1.0.0',
          },
        };
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
            results: simulationResult.results || [],
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
        this.workflow.meta.workflow,
        this.workflow.ipfs_hash,
        this.isProd,
        this.zerodevApiKey,
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
            results: executionResult.results || [],
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
    this.log(`Reporting for workflow ${this.workflow.ipfs_hash}. simulationResult: ${simulationResult}, executionResult: ${executionResult}, triggerResult: ${triggerResult}`);

    // Onchain trigger report
    if (this.onchainCheckResult) {
      this.log('Onchain Triggers:');
      this.onchainCheckResult.results.forEach((res) => {
        if (res.error) {
          this.log(`  Trigger ${res.triggerIndex}: ERROR - ${res.error}`);
        } else {
          this.log(`  Trigger ${res.triggerIndex}: ${res.success ? 'TRUE' : 'FALSE'} (block ${res.blockNumber || 'N/A'})`);
        }
      });

      if (!this.onchainCheckResult.allTrue) {
        this.log('Overall: ONCHAIN CONDITIONS NOT MET - workflow skipped');
      }
    }

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
      }
    }

    if (simulationResult) {
      if ((simulationResult as any).cancelled) {
        this.log(`Simulation: CANCELLED (AA23 validation error)`);
      } else {
        this.log(`Simulation: ${simulationResult.success ? 'SUCCESS' : 'FAILED'}`);
      }

      // Submit report to API
      if (simulationResult.results) {
        for (const result of simulationResult.results) {
          if (!result.userOp) {
            continue;
          }
          const chainId = result.chainId;
          const blockNumber = await this.eventMonitor.getCurrentBlockNumber(chainId);
    
          const report = {
            ipfsHash: this.workflow.ipfs_hash,
            simulationSuccess: simulationResult.success,
            chainsBlockNumbers: {
              [chainId]: Number(blockNumber),
            },
            userOp: bigIntToString(result.userOp),
          };
    
          try {
            await reportingClient.submitReport(report);
          } catch (error) {
            this.error(`Failed to send report for workflow ${this.workflow.ipfs_hash}`, error);
          }
        }
      }
    } else {
      this.log(`Simulation: SKIPPED`);
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
            this.log(`  Session ${idx + 1} UserOpHash: ${result.userOpHash}`);
          }
          if (result.userOp) {
            this.log(`  Session ${idx + 1} userOp: ${JSON.stringify(bigIntToString(result.userOp))}`);
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
      this.log(`Simulation result: ${JSON.stringify(bigIntToString(simulationResult))}`);

      if (simulationResult && (simulationResult as any).cancelled) {
        await this.report(simulationResult, null, triggerSatisfied);
        return { simulationResult, executionResult, cancelled: true };
      }

      if (this.fullNode && simulationResult.success) {
        executionResult = await this.execute(simulationResult);
        this.log(`Execution result: ${JSON.stringify(bigIntToString(executionResult))}`);
      }
    }

    await this.report(simulationResult, executionResult, triggerSatisfied);

    return { simulationResult, executionResult, cancelled: (executionResult as any)?.cancelled || false };
  }

  private async scheduleNextRun(_simulationResult: any, executionResult: any): Promise<void> {
    const triggers = this.workflow.triggers;

    if (!triggers || triggers.length === 0) {
      // For workflows without triggers, run once and then disable by setting null
      await this.db.updateWorkflow(this.workflow.ipfs_hash, { next_simulation_time: null });
      this.log(`Workflow has no triggers, unscheduled after one-time execution.`);
      return;
    }

    const nextTime = getNextSimulationTime(this.workflow);
    if (!nextTime) {
      this.log(`No next simulation time could be determined.`);
      return;
    }

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
      if (this.workflow.meta?.workflow) {
        this.workflow.meta.workflow = new SDKWorkflow(this.workflow.meta.workflow).typify();
      }

      await this.initializeSDK();
      await this.initializeReportingClient(workerData.accessToken, workerData.refreshToken);

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
    getLogger('Worker').error('Worker started without workflow data');
    throw new Error('workerData.workflow is required. Do not run worker.js directly.');
  }

  const { workflow, accessToken, refreshToken } = workerData;
  getLogger('Worker').info(
    `Worker for ${workflow.ipfs_hash} started with token: ${accessToken ? 'present' : 'absent'}`,
  );

  const processor = new WorkflowProcessor(workerData.workflow);
  try {
    getLogger('Worker').info(`Starting processing for workflow: ${workerData.workflow.ipfs_hash}`);
    await processor.process();
    getLogger('Worker').info(`Finished processing for workflow: ${workerData.workflow.ipfs_hash}`);
    if (parentPort) parentPort.postMessage({ success: true });
  } catch (e) {
    const err = e as Error;
    getLogger('Worker').error(`Processing failed for workflow: ${workerData.workflow.ipfs_hash}`, {
      error: err.message || err.toString(),
      stack: err.stack,
    });
    if (parentPort) parentPort.postMessage({ error: { message: err.message, stack: err.stack } });
  }
})();
