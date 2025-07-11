import { createPublicClient, http, parseAbiItem } from 'viem';
import { getConfig } from './config.js';
import { getLogger } from './logger.js';
import type { Workflow as BaseWorkflow } from "./types/workflow.js";
import type { Database } from "./db.js";
type Workflow = BaseWorkflow & { triggers?: any[] };

const cfg = getConfig();
const logger = getLogger('EventMonitor');

type EventConfig = {
  signature: string;
  filter?: Record<string, any>;
  address?: string;
};

export class EventMonitor {
  private clients: Map<number, any>;
  private maxBlockRanges: Map<number, number>;

  constructor() {
    this.clients = new Map();
    this.maxBlockRanges = new Map();
    this.loadMaxBlockRanges();
    this.setupClients();
  }

  private loadMaxBlockRanges(): void {
    Object.entries(cfg.maxBlockRanges).forEach(([chainId, range]) => {
      this.maxBlockRanges.set(Number(chainId), range as number);
    });
  }

  private setupClients(): void {
    Object.entries(cfg.chains).forEach(([chainIdStr, chainObj]) => {
      const chainId = Number(chainIdStr);
      const rpcUrl = (cfg.rpcUrls as Record<number, string>)[chainId];
      if (rpcUrl) {
        this.clients.set(chainId, createPublicClient({ chain: chainObj as any, transport: http(rpcUrl) }) as any);
      }
    });
  }

  async getCurrentBlockNumber(chainId: number): Promise<number> {
    const client = this.clients.get(chainId);
    if (!client) throw new Error(`No RPC client configured for chain ${chainId}`);
    const blockNumber = await client.getBlockNumber();
    return Number(blockNumber);
  }

  private generateTriggerKey(eventTrigger: any, triggerIndex: number): string {
    const signature = eventTrigger.signature?.split('(')[0] || 'unknown';
    const chainId = eventTrigger.chainId || Number(Object.keys(cfg.chains)[0]);
    return `trigger_${triggerIndex}_${signature}_${chainId}`;
  }

  private generateTriggerKeyFromRaw(rawTrigger: any, triggerIndex: number): string {
    const signature = rawTrigger.params?.signature?.split('(')[0] || 'unknown';
    const chainId = rawTrigger.params?.chainId || Number(Object.keys(cfg.chains)[0]);
    return `trigger_${triggerIndex}_${signature}_${chainId}`;
  }

  async initializeLastProcessedBlock(workflow: Workflow, eventTrigger: any, triggerIndex: number, db: Database): Promise<number> {
    const chainId = eventTrigger.chainId || Number(Object.keys(cfg.chains)[0]);
    const currentBlock = await this.getCurrentBlockNumber(chainId);
    const triggerKey = this.generateTriggerKey(eventTrigger, triggerIndex);
    const blockTracking = workflow.block_tracking || {};
    if (!blockTracking[triggerKey]) {
      blockTracking[triggerKey] = {
        signature: eventTrigger.signature,
        chainId,
        address: eventTrigger.address || eventTrigger.filter?.address,
        last_processed_block: currentBlock,
        last_updated: new Date()
      };
      await db.updateWorkflow(workflow.ipfs_hash, { block_tracking: blockTracking });
      workflow.block_tracking = blockTracking;
      logger.info({ trigger: eventTrigger.signature, chainId, currentBlock }, 'initialized last_processed_block');
    }
    return blockTracking[triggerKey].last_processed_block;
  }

  async updateLastProcessedBlock(workflow: Workflow, eventTrigger: any, triggerIndex: number, blockNumber: number, db: Database): Promise<void> {
    const triggerKey = this.generateTriggerKey(eventTrigger, triggerIndex);
    const blockTracking = workflow.block_tracking || {};
    if (!blockTracking[triggerKey]) {
      blockTracking[triggerKey] = {
        signature: eventTrigger.signature,
        chainId: eventTrigger.chainId || Number(Object.keys(cfg.chains)[0]),
        address: eventTrigger.address || eventTrigger.filter?.address,
        last_processed_block: blockNumber,
        last_updated: new Date()
      };
    } else {
      blockTracking[triggerKey].last_processed_block = blockNumber;
      blockTracking[triggerKey].last_updated = new Date();
    }
    await db.updateWorkflow(workflow.ipfs_hash, { block_tracking: blockTracking });
    workflow.block_tracking = blockTracking;
    logger.debug({ trigger: eventTrigger.signature, blockNumber }, 'updated last_processed_block');
  }

  private splitBlockRange(fromBlock: number, toBlock: number, maxChunkSize: number): Array<{ fromBlock: number; toBlock: number }> {
    const chunks: Array<{ fromBlock: number; toBlock: number }> = [];
    let currentStart = fromBlock;
    while (currentStart <= toBlock) {
      const currentEnd = Math.min(currentStart + maxChunkSize - 1, toBlock);
      chunks.push({ fromBlock: currentStart, toBlock: currentEnd });
      currentStart = currentEnd + 1;
    }
    return chunks;
  }

  async queryEventsInRange(chainId: number, eventConfig: EventConfig, fromBlock: number, toBlock: number): Promise<any[]> {
    const client = this.clients.get(chainId);
    if (!client) throw new Error(`No RPC client configured for chain ${chainId}`);
    try {
      const abiItem = parseAbiItem(`event ${eventConfig.signature}`);
      const filterParams: any = { event: abiItem, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) };
      const contractAddress = eventConfig.address || eventConfig.filter?.address;
      if (contractAddress) filterParams.address = contractAddress;
      if (eventConfig.filter && Object.keys(eventConfig.filter).length > 0) {
        const args: Record<string, any> = {};
        Object.keys(eventConfig.filter).forEach(key => {
          if (key !== 'address') args[key] = eventConfig.filter![key];
        });
        if (Object.keys(args).length > 0) filterParams.args = args;
      }
      const logs = await client.getLogs(filterParams);
      return logs;
    } catch (e) {
      const err = e as Error;
      logger.error({ err, chainId, fromBlock, toBlock }, 'error querying events');
      throw err;
    }
  }

  async checkEventTriggers(workflow: Workflow, db: Database): Promise<{ hasEvents: boolean; results: any[] }> {
    const triggers = workflow.triggers || [];
    const eventTriggers = triggers.filter((t: any) => t.type === 'event');
    if (eventTriggers.length === 0) return { hasEvents: true, results: [] };
    logger.info({ workflow: workflow.getIpfsHashShort(), triggers: eventTriggers.length }, 'checking event triggers');
    const triggersByChain = new Map<number, Array<{ trigger: any; index: number }>>();
    eventTriggers.forEach((trigger: any, index: number) => {
      const chainId = trigger.params?.chainId || Number(Object.keys(cfg.chains)[0]);
      if (!triggersByChain.has(chainId)) triggersByChain.set(chainId, []);
      triggersByChain.get(chainId)!.push({ trigger, index });
    });
    let anyEventFound = false;
    const eventResults: any[] = [];
    for (const [chainId, chainTriggers] of triggersByChain) {
      try {
        const currentBlock = await this.getCurrentBlockNumber(chainId);
        const chainKey = `chain_${chainId}`;
        let lastProcessedBlock = workflow.block_tracking?.[chainKey]?.last_processed_block;
        if (!lastProcessedBlock) {
          logger.warn({ chainId, workflow: workflow.getIpfsHashShort() }, 'block tracking not initialized');
          chainTriggers.forEach(({ trigger, index }) => {
            eventResults.push({ triggerIndex: index, chainId, signature: trigger.params?.signature || 'unknown', error: `Chain ${chainId} block tracking not initialized`, fromBlock: null, toBlock: null, blocksChecked: 0 });
          });
          continue;
        }
        if (lastProcessedBlock >= currentBlock) {
          chainTriggers.forEach(({ trigger, index }) => {
            eventResults.push({ triggerIndex: index, chainId, signature: trigger.params?.signature || 'unknown', eventsFound: 0, blocksChecked: 0, fromBlock: lastProcessedBlock, toBlock: currentBlock, lastBlock: lastProcessedBlock });
          });
          continue;
        }
        const maxChunkSize = this.maxBlockRanges.get(chainId) || 10000;
        const totalBlocks = currentBlock - lastProcessedBlock;
        logger.debug({ chainId, totalBlocks, triggers: chainTriggers.length }, 'processing chain');
        const chunks = this.splitBlockRange(lastProcessedBlock + 1, currentBlock, maxChunkSize);
        for (const { trigger, index } of chainTriggers) {
          const signature = trigger.params?.signature;
          if (!signature) {
            eventResults.push({ triggerIndex: index, chainId, signature: 'unknown', error: 'Missing event signature in trigger params', fromBlock: null, toBlock: null, blocksChecked: 0 });
            continue;
          }
          let totalEventsFound = 0;
          const eventConfig: EventConfig = { signature, filter: trigger.params?.filter || {}, address: trigger.params?.address || trigger.params?.contractAddress };
          for (const chunk of chunks) {
            const events = await this.queryEventsInRange(chainId, eventConfig, chunk.fromBlock, chunk.toBlock);
            totalEventsFound += events.length;
            if (events.length > 0) anyEventFound = true;
          }
          eventResults.push({ triggerIndex: index, chainId, signature, eventsFound: totalEventsFound, blocksChecked: totalBlocks, fromBlock: lastProcessedBlock + 1, toBlock: currentBlock, lastBlock: currentBlock });
        }
        if (!workflow.block_tracking) workflow.block_tracking = {};
        workflow.block_tracking[chainKey] = { last_processed_block: currentBlock, last_updated: new Date() };
        await db.updateWorkflow(workflow.ipfs_hash, { block_tracking: workflow.block_tracking });
        logger.info({ chainId, currentBlock }, 'updated chain last_processed_block');
      } catch (e) {
        const err = e as Error;
        logger.error({ err, chainId }, 'error checking events');
        triggersByChain.get(chainId)!.forEach(({ trigger, index }) => {
          eventResults.push({ triggerIndex: index, chainId, signature: trigger.params?.signature || 'unknown', error: err.message, fromBlock: null, toBlock: null, blocksChecked: 0 });
        });
      }
    }
    return { hasEvents: anyEventFound, results: eventResults };
  }
}

export default EventMonitor; 