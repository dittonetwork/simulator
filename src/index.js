import dotenv from 'dotenv';
dotenv.config();
import { Worker } from 'worker_threads';
import { Database } from './db.js';

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