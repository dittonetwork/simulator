import dotenv from 'dotenv';
dotenv.config();
import { Worker } from 'worker_threads';
import { Database } from './db.js';
import cronParser from 'cron-parser';
import { parseCronConfig } from './parsers/cronParser.js';
import { getNextSimulationTime } from './parsers/cronParser.js';

class Simulator {
    constructor() {
        this.sleep = parseInt(process.env.RUNNER_NODE_SLEEP || '60', 10) * 1000;
        this.maxWorkers = parseInt(process.env.MAX_WORKERS || '4', 10);
        this.db = new Database();
    }

    async processWithWorkers(workflows) {
        let active = 0;
        let idx = 0;
        return new Promise((resolve) => {
            const next = () => {
                if (idx >= workflows.length && active === 0) {
                    return resolve();
                }
                while (active < this.maxWorkers && idx < workflows.length) {
                    const workflow = workflows[idx++];
                    active++;
                    const worker = new Worker(new URL('./worker.js', import.meta.url), {
                        workerData: { workflow }
                    });
                    worker.on('message', (result) => {
                        if (result && result.error) {
                            console.error('Worker error:', result.error);
                        }
                    });
                    worker.on('error', (err) => {
                        console.error('Worker thread error:', err);
                    });
                    worker.on('exit', () => {
                        active--;
                        next();
                    });
                }
            };
            next();
        });
    }

    async run() {
        await this.db.connect();
        try {
            while (true) {
                // Backfill: directly update next_simulation_time for missing workflows
                const missingNextTime = await this.db.getWorkflowsMissingNextSimulationTime(20); // limit to 20 per loop
                if (missingNextTime.length > 0) {
                    console.info(`[Simulator] Backfilling ${missingNextTime.length} workflows missing next_simulation_time...`);
                    for (const workflow of missingNextTime) {
                        try {
                            // Use the shared utility, which now handles all validation
                            const nextTime = getNextSimulationTime(workflow.meta && workflow.meta.simulationConfig);
                            await this.db.updateWorkflow(workflow.ipfs_hash, { next_simulation_time: nextTime });
                            console.info(`[Simulator] Set next_simulation_time for workflow ${workflow.ipfs_hash}: ${nextTime.toISOString()}`);
                        } catch (e) {
                            console.warn(`[Simulator] Failed to backfill workflow ${workflow.ipfs_hash}: ${e.message}`);
                        }
                    }
                }
                // Regular processing
                const workflows = await this.db.getRelevantWorkflows();
                console.debug(`[Simulator] Gathered ${workflows.length} workflows for processing.`);
                await this.processWithWorkers(workflows);
                await new Promise(res => setTimeout(res, this.sleep));
            }
        } catch (err) {
            console.error('Error in main loop:', err);
        } finally {
            await this.db.close();
        }
    }
}

// Entry point
const simulator = new Simulator();
simulator.run(); 