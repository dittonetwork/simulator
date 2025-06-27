export class Workflow {
    constructor(rawWorkflow) {
        if (!rawWorkflow || typeof rawWorkflow !== 'object') {
            throw new Error('Workflow must be an object');
        }

        this.ipfs_hash = rawWorkflow.ipfs_hash;
        this.meta = rawWorkflow.meta;
        this.runs = rawWorkflow.runs;
        this.is_cancelled = rawWorkflow.is_cancelled;
        this.next_simulation_time = rawWorkflow.next_simulation_time;
        this.block_tracking = rawWorkflow.block_tracking;
        // Validate meta
        const meta = this.meta;
        if (!meta || typeof meta !== 'object') {
            throw new Error('meta must be an object, wait for the ipfs retrieval and retry');
        }
        // Extract chainIds from meta.workflow.jobs
        if (!(meta.workflow && Array.isArray(meta.workflow.jobs))) {
            throw new Error('meta.workflow.jobs must be a non-empty array');
        }
        // Validate owner
        if (!(typeof meta.workflow.owner === 'string' && meta.workflow.owner)) {
            throw new Error('meta.workflow.owner is required');
        }
        // Validate triggers
        if (!Array.isArray(meta.workflow.triggers) || meta.workflow.triggers.length === 0) {
            throw new Error('meta.workflow.triggers must be a non-empty array');
        }
        // Enforce each trigger has type and params
        for (const [i, trigger] of meta.workflow.triggers.entries()) {
            if (typeof trigger.type !== 'string' || !trigger.type) {
                throw new Error(`Trigger at index ${i} is missing a valid 'type' property`);
            }
            if (typeof trigger.params !== 'object' || trigger.params === null) {
                throw new Error(`Trigger at index ${i} is missing a valid 'params' object`);
            }
        }
    }

    get owner() { return this.meta.workflow.owner; }
    get triggers() { return this.meta.workflow.triggers; }
    get jobs() { return this.meta.workflow.jobs; }

    getIpfsHashShort() {
        const hash = this.ipfs_hash || '';
        if (hash.length <= 8) return hash;
        return `${hash.slice(0, 4)}...${hash.slice(-4)}`;
    }
} 