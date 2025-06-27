import dotenv from 'dotenv';
dotenv.config();
import { Worker } from 'worker_threads';
import { Database } from './db.js';
import cronParser from 'cron-parser';
import { parseCronConfig } from './parsers/cronParser.js';
import { getNextSimulationTime } from './parsers/cronParser.js';
import EventMonitor from './eventMonitor.js';

class Simulator {
    constructor() {
        this.sleep = parseInt(process.env.RUNNER_NODE_SLEEP || '60', 10) * 1000;
        this.maxWorkers = parseInt(process.env.MAX_WORKERS || '4', 10);
        this.db = new Database();
        this.eventMonitor = new EventMonitor();
        this.blockNumberCache = new Map(); // Cache block numbers per chain
        this.supportedChains = [11155111, 1]; // Sepolia, Mainnet
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

    async ensureNextSimTime(workflows) {
        if (workflows.length === 0) return;

        console.info(`[Simulator] Ensuring next_simulation_time for ${workflows.length} workflows...`);

        for (const workflow of workflows) {
            try {
                const nextTime = getNextSimulationTime(workflow.triggers);
                await this.db.updateWorkflow(workflow.ipfs_hash, { next_simulation_time: nextTime });
                console.info(`[Simulator] Set next_simulation_time for workflow ${workflow.getIpfsHashShort()}: ${nextTime.toISOString()}`);
            } catch (e) {
                console.warn(`[Simulator] Failed to set next_simulation_time for workflow ${workflow.getIpfsHashShort()}: ${e.message}`);
            }
        }
    }

    async getCurrentBlockNumbers(chainIds) {
        // Use cache for same execution cycle, clear cache each cycle
        this.blockNumberCache.clear();

        console.info(`[Simulator] Fetching current block numbers for chains: ${Array.from(chainIds).join(', ')}`);

        for (const chainId of chainIds) {
            if (!this.supportedChains.includes(chainId)) {
                console.warn(`[Simulator] Skipping unsupported chain ${chainId}`);
                continue;
            }

            try {
                const blockNumber = await this.eventMonitor.getCurrentBlockNumber(chainId);
                this.blockNumberCache.set(chainId, blockNumber);
                console.info(`[Simulator] Chain ${chainId}: Current block ${blockNumber}`);
            } catch (error) {
                console.warn(`[Simulator] Failed to get block number for chain ${chainId}: ${error.message}`);
            }
        }
    }

    extractChainsFromTriggers(workflows) {
        const chainIds = new Set();

        for (const workflow of workflows) {
            for (const trigger of workflow.triggers) {
                if (trigger.type === 'event') {
                    // Extract from raw trigger format
                    const chainId = trigger.params?.chainId || 11155111; // Default to Sepolia
                    chainIds.add(chainId);
                }
            }
        }

        return chainIds;
    }

    async ensureEventTriggersSetUp(workflows) {
        if (workflows.length === 0) return;

        console.info(`[Simulator] Setting up event triggers for ${workflows.length} workflows...`);

        // Extract all unique chain IDs from all workflows
        const requiredChainIds = this.extractChainsFromTriggers(workflows);

        if (requiredChainIds.size === 0) {
            console.info(`[Simulator] No event triggers found, skipping event setup`);
            return;
        }

        // Fetch current block numbers once for all chains
        await this.getCurrentBlockNumbers(requiredChainIds);

        // Initialize block tracking for each workflow with ALL found chain IDs
        for (const workflow of workflows) {
            try {
                await this.initializeWorkflowEventTracking(workflow, requiredChainIds);
            } catch (error) {
                console.warn(`[Simulator] Failed to initialize event tracking for workflow ${workflow.getIpfsHashShort()}: ${error.message}`);
            }
        }
    }

    async ensureBlockTrackingForAll(workflows) {
        console.info(`[Simulator] Ensuring block tracking for ${workflows.length} workflows about to be processed...`);

        // Extract all unique chain IDs from event triggers in these workflows
        const requiredChainIds = this.extractChainsFromTriggers(workflows);

        if (requiredChainIds.size === 0) {
            console.info(`[Simulator] No event triggers found in ready workflows, skipping block tracking setup`);
            return;
        }

        // Get current block numbers for required chains (fetch fresh if not cached)
        for (const chainId of requiredChainIds) {
            if (!this.blockNumberCache.has(chainId)) {
                if (!this.supportedChains.includes(chainId)) {
                    console.warn(`[Simulator] Skipping unsupported chain ${chainId}`);
                    continue;
                }

                try {
                    const blockNumber = await this.eventMonitor.getCurrentBlockNumber(chainId);
                    this.blockNumberCache.set(chainId, blockNumber);
                    console.info(`[Simulator] Chain ${chainId}: Fetched current block ${blockNumber}`);
                } catch (error) {
                    console.warn(`[Simulator] Failed to get block number for chain ${chainId}: ${error.message}`);
                }
            }
        }

        // Initialize block tracking for workflows that need it
        for (const workflow of workflows) {
            try {
                await this.initializeWorkflowEventTracking(workflow, requiredChainIds);
            } catch (error) {
                console.warn(`[Simulator] Failed to initialize event tracking for workflow ${workflow.getIpfsHashShort()}: ${error.message}`);
            }
        }
    }

    async initializeWorkflowEventTracking(workflow, allChainIds) {
        const blockTracking = workflow.block_tracking || {};
        let hasUpdates = false;

        // Initialize chains that this workflow actually uses (not all chains)
        const workflowChainIds = this.extractChainsFromTriggers([workflow]);

        for (const chainId of workflowChainIds) {
            const chainKey = `chain_${chainId}`;

            // Skip if already initialized
            if (blockTracking[chainKey]) continue;

            // Use cached block number
            const currentBlock = this.blockNumberCache.get(chainId);
            if (!currentBlock) {
                console.warn(`[Simulator] No cached block number for chain ${chainId}, skipping`);
                continue;
            }

            // Initialize tracking for this chain
            blockTracking[chainKey] = {
                last_processed_block: currentBlock,
                last_updated: new Date()
            };

            hasUpdates = true;
            console.info(`[Simulator] Initialized chain ${chainId} tracking for workflow ${workflow.getIpfsHashShort()} at block ${currentBlock}`);
        }

        // Update workflow if we made changes
        if (hasUpdates) {
            await this.db.updateWorkflow(workflow.ipfs_hash, { block_tracking: blockTracking });
            console.debug(`[Simulator] Updated block tracking for ${workflow.getIpfsHashShort()}: ${JSON.stringify(blockTracking)}`);
        }
    }

    async run() {
        await this.db.connect();
        try {
            while (true) {
                // 1. Ensure workflows have next_simulation_time
                const missingNextTime = await this.db.getWorkflowsMissingNextSimulationTime(20);
                if (missingNextTime.length > 0) {
                    await this.ensureNextSimTime(missingNextTime);
                    await this.ensureEventTriggersSetUp(missingNextTime);
                }

                // 2. Process ready workflows with workers
                const workflows = await this.db.getRelevantWorkflows();
                console.debug(`[Simulator] Gathered ${workflows.length} workflows for processing.`);

                // 2.5. Ensure block tracking for ALL workflows about to be processed
                if (workflows.length > 0) {
                    await this.ensureBlockTrackingForAll(workflows);

                    // 2.6. Reload workflows from DB to get updated block tracking
                    const workflowHashes = workflows.map(w => w.ipfs_hash);
                    const updatedWorkflows = await this.db.getWorkflowsByHashes(workflowHashes);
                    console.debug(`[Simulator] Reloaded ${updatedWorkflows.length} workflows with updated block tracking.`);

                    // Debug: Check if workflows actually have block tracking now
                    updatedWorkflows.forEach(w => {
                        const blockTracking = w.block_tracking || {};
                        const chainKeys = Object.keys(blockTracking);
                        console.debug(`[Simulator] Workflow ${w.getIpfsHashShort()} block_tracking: ${chainKeys.length} chains - ${JSON.stringify(blockTracking)}`);
                    });

                    await this.processWithWorkers(updatedWorkflows);
                } else {
                    await this.processWithWorkers(workflows);
                }

                // 3. Sleep before next cycle
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