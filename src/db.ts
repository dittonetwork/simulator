import { MongoClient, Db, ClientSession } from 'mongodb';
import dotenv from 'dotenv';
import { Workflow } from './types/workflow.js';
import logger from './logger.js';
import { COLLECTIONS } from './constants.js';
import { getConfig } from './config.js';
import { serializeIpfs } from './utils.js';
import { WorkflowDocument } from './types/interfaces.js';

dotenv.config();

export class Database {
  private mongoUri: string;

  private dbName: string;

  private client: MongoClient | null = null;

  private db: Db | null = null;

  constructor() {
    const cfg = getConfig();
    this.mongoUri = cfg.mongoUri;
    this.dbName = cfg.dbName;
  }

  async connect(): Promise<Db> {
    if (!this.client) {
      this.client = new MongoClient(this.mongoUri);
      await this.client.connect();
      this.db = this.client.db(this.dbName);
    }
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }

  getClient(): MongoClient | null {
    return this.client;
  }

  async getRelevantWorkflows(): Promise<Workflow[]> {
    const now = new Date();
    const nowInSeconds = Math.floor(now.getTime() / 1000);
    if (!this.db) throw new Error('Database not connected');

    const rawWorkflows = await this.db
      .collection<WorkflowDocument>(COLLECTIONS.WORKFLOWS)
      .find({
        is_cancelled: false,
        $or: [
          { next_simulation_time: { $lte: now } },
          {
            'meta.workflow.triggers': { $exists: false, $eq: [] },
            'meta.workflow.validAfter': { $lte: nowInSeconds },
            'meta.workflow.validUntil': { $gte: nowInSeconds },
          },
        ],
      })
      .toArray();

    const validWorkflows: Workflow[] = [];
    for (const raw of rawWorkflows) {
      try {
        if (!raw.ipfs_hash) throw new Error('Missing ipfs_hash');
        validWorkflows.push(new Workflow(raw));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`Skipping invalid workflow: ${serializeIpfs(raw.ipfs_hash)} - ${msg}`);
      }
    }
    return validWorkflows;
  }

  async getWorkflowsMissingNextSimulationTime(limit: number = getConfig().maxMissingNextSimLimit): Promise<Workflow[]> {
    if (!this.db) throw new Error('Database not connected');
    const rawWorkflows = await this.db
      .collection<WorkflowDocument>(COLLECTIONS.WORKFLOWS)
      .find({
        is_cancelled: false,
        next_simulation_time: { $exists: false },
      })
      .limit(limit)
      .toArray();
    const validWorkflows: Workflow[] = [];
    for (const raw of rawWorkflows) {
      try {
        if (!raw.ipfs_hash) throw new Error('Missing ipfs_hash');
        validWorkflows.push(new Workflow(raw));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(
          `Skipping invalid workflow (missing next_simulation_time): ${serializeIpfs(raw.ipfs_hash)} - ${msg}`,
        );
      }
    }
    return validWorkflows;
  }

  async getWorkflowsByHashes(ipfsHashes: string[]): Promise<Workflow[]> {
    if (!this.db) throw new Error('Database not connected');
    const rawWorkflows = await this.db
      .collection<WorkflowDocument>(COLLECTIONS.WORKFLOWS)
      .find({
        ipfs_hash: { $in: ipfsHashes },
      })
      .toArray();
    const validWorkflows: Workflow[] = [];
    for (const raw of rawWorkflows) {
      try {
        if (!raw.ipfs_hash) throw new Error('Missing ipfs_hash');
        validWorkflows.push(new Workflow(raw));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`Skipping invalid workflow (reload): ${serializeIpfs(raw.ipfs_hash)} - ${msg}`);
      }
    }
    return validWorkflows;
  }

  async getUnsyncedChainsCount(): Promise<number> {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection(COLLECTIONS.CHAINS).countDocuments({
      is_synced: false,
    });
  }

  async updateWorkflow(ipfsHash: string, updateFields: Partial<WorkflowDocument>) {
    if (!this.db) throw new Error('Database not connected');
    const execute = async (sess?: ClientSession) =>
      this.db!.collection<WorkflowDocument>(COLLECTIONS.WORKFLOWS).updateOne(
        { ipfs_hash: ipfsHash },
        { $set: updateFields },
        sess ? { session: sess } : {}
      );

    return this.withTransaction(async (sess) => execute(sess));
  }

  async findWorkflowByIpfs(ipfsHash: string, session?: ClientSession) {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<WorkflowDocument>(COLLECTIONS.WORKFLOWS).findOne({ ipfs_hash: ipfsHash }, { session });
  }

  async insertWorkflow(workflowDoc: WorkflowDocument) {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<WorkflowDocument>(COLLECTIONS.WORKFLOWS).insertOne(workflowDoc);
  }

  async withTransaction<T>(callback: (session: ClientSession) => Promise<T>): Promise<T> {
    const client = this.getClient();
    if (!client || !client.startSession) {
      throw new Error('MongoClient not initialized or does not support sessions');
    }
    const session = client.startSession();
    try {
      let result: T;
      try {
        await session.withTransaction(async () => {
          result = await callback(session);
        });
      } catch (e: any) {
        // Fallback if transactions unsupported (e.g., standalone)
        if (e.message && e.message.includes('Transaction numbers are only allowed on a replica set member or mongos')) {
          result = await callback(undefined as any);
        } else {
          throw e;
        }
      }
      await session.endSession();
      return result!;
    } catch (e) {
      await session.endSession();
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('Transaction failed:', msg);
      throw e;
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }
}
