import { parentPort, workerData } from 'worker_threads';
import dotenv from 'dotenv';
dotenv.config();
import cronParser from 'cron-parser';
import { Database } from './db.js';
import { parseCronConfig, getNextSimulationTime } from './parsers/cronParser.js';
import { parseEventConfig } from './parsers/eventParser.js';
import { Workflow } from './validators/metaValidator.js';

if (!workerData || !workerData.workflow) {
    throw new Error('workerData.workflow is required. Do not run worker.js directly.');
}

class WorkflowProcessor {
    constructor(workflow) {
        this.workflow = workflow;
        this.fullNode = process.env.FULL_NODE === 'true';
        this.db = new Database();
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
        // Mock simulation
        console.log(`[Step] Simulating workflow ${this.workflow.getIpfsHashShort()}`);
        return { simulated: true };
    }

    async report(simulationResult) {
        // Mock reporting
        console.log(`[Step] Reporting for workflow ${this.workflow.getIpfsHashShort()} Result:`, simulationResult);
        return true;
    }

    async broadcast(simulationResult) {
        // Mock broadcasting
        console.log(`[Step] Broadcasting for workflow ${this.workflow.getIpfsHashShort()} Result:`, simulationResult);
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
        await this.understandTrigger();
        const simulationResult = await this.simulate();
        await this.report(simulationResult);
        if (this.fullNode) {
            await this.broadcast(simulationResult);
        }
        // Only support new format
        // No need to check triggers here; Workflow validator already did it
        const nextTime = getNextSimulationTime(this.workflow.triggers);
        if (nextTime) {
            console.log(`[Cron] Calculated next_simulation_time for workflow ${this.workflow.getIpfsHashShort()}: ${nextTime.toISOString()}`);
            try {
                await this.db.withTransaction(async (session) => {
                    await this.db.updateWorkflow(this.workflow.ipfs_hash, { next_simulation_time: nextTime }, session);
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
        parentPort.postMessage({ error: e.message });
    }
})();