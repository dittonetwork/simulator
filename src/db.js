import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();
import { Workflow } from './validators/metaValidator.js';
import logger from './logger.js';

export class Database {
    constructor() {
        this.mongoUri = process.env.MONGO_URI;
        this.dbName = process.env.DB_NAME || 'indexer';
        this.client = null;
        this.db = null;
    }

    async connect() {
        if (!this.client) {
            this.client = new MongoClient(this.mongoUri);
            await this.client.connect();
            this.db = this.client.db(this.dbName);
        }
        return this.db;
    }

    getClient() {
        return this.client;
    }

    async getRelevantWorkflows() {
        const now = new Date();
        const rawWorkflows = await this.db.collection('workflows').find({
            is_cancelled: false,
            next_simulation_time: { $lte: now }
        }).toArray();
        const validWorkflows = [];
        for (const raw of rawWorkflows) {
            try {
                if (!raw.ipfs_hash) throw new Error('Missing ipfs_hash');
                validWorkflows.push(new Workflow(raw));
            } catch (e) {
                logger.warn(`[DB] Skipping invalid workflow: ${raw.ipfs_hash ? (raw.ipfs_hash.slice(0, 4) + '...' + raw.ipfs_hash.slice(-4)) : ''} - ${e.message}`);
            }
        }
        return validWorkflows;
    }

    async getWorkflowsMissingNextSimulationTime(limit = 100) {
        const rawWorkflows = await this.db.collection('workflows').find({
            is_cancelled: false,
            next_simulation_time: { $exists: false }
        }).limit(limit).toArray();
        const validWorkflows = [];
        for (const raw of rawWorkflows) {
            try {
                if (!raw.ipfs_hash) throw new Error('Missing ipfs_hash');
                validWorkflows.push(new Workflow(raw));
            } catch (e) {
                console.log(e);
                logger.warn(`[DB] Skipping invalid workflow (missing next_simulation_time): ${raw.ipfs_hash ? (raw.ipfs_hash.slice(0, 4) + '...' + raw.ipfs_hash.slice(-4)) : ''} - ${e.message}`);
            }
        }
        return validWorkflows;
    }

    async getWorkflowsByHashes(ipfsHashes) {
        const rawWorkflows = await this.db.collection('workflows').find({
            ipfs_hash: { $in: ipfsHashes }
        }).toArray();
        const validWorkflows = [];
        for (const raw of rawWorkflows) {
            try {
                if (!raw.ipfs_hash) throw new Error('Missing ipfs_hash');
                validWorkflows.push(new Workflow(raw));
            } catch (e) {
                logger.warn(`[DB] Skipping invalid workflow (reload): ${raw.ipfs_hash ? (raw.ipfs_hash.slice(0, 4) + '...' + raw.ipfs_hash.slice(-4)) : ''} - ${e.message}`);
            }
        }
        return validWorkflows;
    }

    async updateWorkflow(ipfsHash, updateFields, session) {
        try {
            const opts = session ? { session } : {};
            return await this.db.collection('workflows').updateOne(
                { ipfs_hash: ipfsHash },
                { $set: updateFields },
                opts
            );
        } catch (e) {
            logger.error('[DB] Failed to update workflow:', e);
            throw e;
        }
    }

    async findWorkflowByIpfs(ipfsHash, session) {
        return this.db.collection('workflows').findOne({ ipfs_hash: ipfsHash }, { session });
    }

    async insertWorkflow(workflowDoc, session) {
        return this.db.collection('workflows').insertOne(workflowDoc, { session });
    }

    async withTransaction(callback) {
        const client = this.getClient();
        if (!client || !client.startSession) {
            throw new Error('MongoClient not initialized or does not support sessions');
        }
        const session = client.startSession();
        try {
            let result;
            await session.withTransaction(async () => {
                result = await callback(session);
            });
            await session.endSession();
            return result;
        } catch (e) {
            await session.abortTransaction();
            await session.endSession();
            logger.error('[DB] Transaction failed:', e);
            throw e;
        }
    }

    async close() {
        if (this.client) {
            await this.client.close();
            this.client = null;
            this.db = null;
        }
    }
} 