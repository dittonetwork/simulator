import { parentPort, workerData } from 'worker_threads';
import dotenv from 'dotenv';
dotenv.config();
import cronParser from 'cron-parser';
import { Database } from './db.js';
import { parseCronConfig } from './parsers/cronParser.js';
import { parseEventTriggerConfig } from './parsers/eventTriggerParser.js';
import { Workflow } from './validators/metaValidator.js';

class WorkflowProcessor {
    constructor(workflow) {
        this.workflow = workflow;
        this.fullNode = process.env.FULL_NODE === 'true';
        this.db = new Database();
    }

    parseSimulationConfigItems(simConfigs) {
        return simConfigs.map((cfg, idx) => {
            try {
                if (cfg.type === 'cron' || cfg.expression || (cfg.params && cfg.params.expression)) {
                    const parsed = parseCronConfig(cfg);
                    console.debug(`[Parser] Parsed cron config at index ${idx}:`, parsed);
                    return parsed;
                } else if (cfg.eventTrigger || (cfg.type && cfg.type === 'eventTrigger')) {
                    const parsed = parseEventTriggerConfig(cfg);
                    console.debug(`[Parser] Parsed eventTrigger config at index ${idx}:`, parsed);
                    return parsed;
                } else {
                    console.warn(`[Parser] Unknown simulationConfig type at index ${idx}:`, cfg);
                    return { type: 'unknown', raw: cfg };
                }
            } catch (e) {
                console.error(`[Parser] Error parsing simulationConfig at index ${idx}:`, e.message);
                return { type: 'invalid', error: e.message, raw: cfg };
            }
        });
    }

    getNextSimulationTime(simConfigs) {
        let nextTime = null;
        for (const cfg of simConfigs) {
            // Only handle cron configs
            if (cfg.type === 'cron' || cfg.expression || (cfg.params && cfg.params.expression)) {
                let cronExpr = cfg.expression || (cfg.params && cfg.params.expression);
                if (!cronExpr) continue;
                try {
                    const now = new Date();
                    const interval = cronParser.parseExpression(cronExpr, { currentDate: now });
                    const candidateTime = interval.next().toDate();
                    if (!nextTime) {
                        nextTime = candidateTime;
                    } else {
                        // Optionally warn about multiple crons
                    }
                } catch (e) {
                    console.error('Invalid cron expression', cronExpr, e);
                }
            }
        }
        return nextTime;
    }

    getIpfsHashShort() {
        const hash = this.workflow.ipfs_hash || '';
        if (hash.length <= 8) return hash;
        return `${hash.slice(0, 4)}...${hash.slice(-4)}`;
    }

    async understandTrigger() {
        // Parse and log each simulationConfig item
        const meta = this.workflow.meta;
        if (!meta || !Array.isArray(meta.simulationConfig)) {
            throw new Error('Invalid workflow meta/simulationConfig');
        }
        this.parseSimulationConfigItems(meta.simulationConfig);
        console.log(`[Step] Understanding trigger for workflow ${this.getIpfsHashShort()}`);
        return true;
    }

    async simulate() {
        // Mock simulation
        console.log(`[Step] Simulating workflow ${this.getIpfsHashShort()}`);
        return { simulated: true };
    }

    async report(simulationResult) {
        // Mock reporting
        console.log(`[Step] Reporting for workflow ${this.getIpfsHashShort()} Result:`, simulationResult);
        return true;
    }

    async broadcast(simulationResult) {
        // Mock broadcasting
        console.log(`[Step] Broadcasting for workflow ${this.getIpfsHashShort()} Result:`, simulationResult);
        return true;
    }

    async process() {
        await this.db.connect();
        let workflowObj;
        try {
            workflowObj = new Workflow(this.workflow);
            console.log(`[Validator] Workflow ${workflowObj.ipfs_hash ? (workflowObj.ipfs_hash.slice(0, 4) + '...' + workflowObj.ipfs_hash.slice(-4)) : ''} validated successfully.`);
        } catch (e) {
            console.error(`[Validator] Workflow validation failed:`, e.message);
            await this.db.close();
            throw e;
        }
        // Log workflow metadata
        if (workflowObj.metadata) {
            console.log(`[Meta] Workflow ${workflowObj.ipfs_hash ? (workflowObj.ipfs_hash.slice(0, 4) + '...' + workflowObj.ipfs_hash.slice(-4)) : ''} metadata:`, JSON.stringify(workflowObj.metadata.text));
        } else {
            console.log(`[Meta] Workflow ${workflowObj.ipfs_hash ? (workflowObj.ipfs_hash.slice(0, 4) + '...' + workflowObj.ipfs_hash.slice(-4)) : ''} has no metadata.`);
        }
        // Use workflowObj for all further processing
        this.workflow = workflowObj;
        const meta = workflowObj.meta;
        await this.understandTrigger();
        const simulationResult = await this.simulate();
        await this.report(simulationResult);
        if (this.fullNode) {
            await this.broadcast(simulationResult);
        }
        const nextTime = this.getNextSimulationTime(meta.simulationConfig);
        if (nextTime) {
            console.log(`[Cron] Calculated next_simulation_time for workflow ${this.getIpfsHashShort()}: ${nextTime.toISOString()}`);
            try {
                console.log(`[DB] Starting transaction for workflow ${this.getIpfsHashShort()}`);
                await this.db.withTransaction(async (session) => {
                    await this.db.updateWorkflow(this.workflow.ipfs_hash, { next_simulation_time: nextTime }, session);
                });
                console.log(`[DB] Transaction committed for workflow ${this.getIpfsHashShort()}`);
            } catch (e) {
                console.error(`[DB] Transaction failed for workflow ${this.getIpfsHashShort()}:`, e);
            }
        }
        await this.db.close();
    }
}

// Entry point for worker thread
(async () => {
    const processor = new WorkflowProcessor(workerData.workflow);
    try {
        await processor.process();
        parentPort.postMessage({ success: true });
    } catch (e) {
        parentPort.postMessage({ error: e.message });
    }
})();