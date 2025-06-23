import { ObjectId } from 'mongodb';

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
        // Validate meta
        const meta = this.meta;
        if (!meta || typeof meta !== 'object') {
            throw new Error('meta must be an object');
        }
        if (!Array.isArray(meta.chainIds) || meta.chainIds.length === 0) {
            throw new Error('meta.chainIds must be a non-empty array');
        }
        if (typeof meta.executions !== 'number') {
            throw new Error('meta.executions must be a number');
        }
        if (!Array.isArray(meta.simulationConfig) || meta.simulationConfig.length === 0) {
            throw new Error('meta.simulationConfig must be a non-empty array');
        }
        if (!meta.account || typeof meta.account.address !== 'string' || !meta.account.address) {
            throw new Error('meta.account.address is required');
        }
        if (!meta.metadata || typeof meta.metadata.text !== 'string' || !meta.metadata.text) {
            throw new Error('meta.metadata.text is required');
        }
        if (!meta.executionConfig || !Array.isArray(meta.executionConfig.actions) || meta.executionConfig.actions.length === 0) {
            throw new Error('meta.executionConfig.actions must be a non-empty array');
        }
    }

    get chainIds() { return this.meta.chainIds; }
    get executions() { return this.meta.executions; }
    get simulationConfig() { return this.meta.simulationConfig; }
    get account() { return this.meta.account; }
    get metadata() { return this.meta.metadata; }
    get executionConfig() { return this.meta.executionConfig; }
} 