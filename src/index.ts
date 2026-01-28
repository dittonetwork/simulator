import dotenv from 'dotenv';
import { Worker } from 'worker_threads';
import express from 'express';
import bodyParser from 'body-parser';
import { getLogger } from './logger.js';
import { Database } from './db.js';
import { getNextSimulationTime } from './parsers/cronParser.js';
import EventMonitor from './eventMonitor.js';
import { CHAIN_IDS, TRIGGER_TYPE } from './constants.js';
import type { Workflow } from './types/workflow.js';
import { reportingClient } from './reportingClient.js';
import { getConfig } from './config.js';
import validateRouter from './validateApi.js';
import { wasmHealthHandler, wasmRunHandler } from './server.js';

dotenv.config();
const logger = getLogger('Simulator');

// Check if running in sandbox mode (WASM-only mode)
// Sandbox mode skips all simulator initialization (DB, EventMonitor, etc.)
// Note: Modules are still imported (they call getConfig() at import time),
// but IPFS_SERVICE_URL is set in docker-compose.yml to prevent errors
const isSandboxMode = process.env.API_ONLY === 'true' && !process.env.MONGO_URI;

class Simulator {
  private sleep!: number;

  private maxWorkers!: number;

  private db!: Database;

  private eventMonitor!: EventMonitor;

  private blockNumberCache!: Map<number, number>;

  private supportedChains!: number[];

  private chainSyncCheckInterval!: number;

  private tokenRefreshInterval!: number;

  constructor() {
    this.sleep = parseInt(process.env.RUNNER_NODE_SLEEP || '60', 10) * 1000;
    this.maxWorkers = parseInt(process.env.MAX_WORKERS || '4', 10);
    this.chainSyncCheckInterval = parseInt(process.env.CHAIN_SYNC_CHECK_INTERVAL_MS || '5000', 10);
    this.tokenRefreshInterval = parseInt(process.env.TOKEN_REFRESH_INTERVAL_MS || '3600000', 10);
    this.db = new Database();
    this.eventMonitor = new EventMonitor();
    this.blockNumberCache = new Map<number, number>(); // Cache block numbers per chain
    this.supportedChains = [CHAIN_IDS.SEPOLIA, CHAIN_IDS.MAINNET];
  }

  async processWithWorkers(workflows: Workflow[]): Promise<void> {
    let active = 0;
    let idx = 0;
    return new Promise<void>((resolve) => {
      const next = () => {
        if (idx >= workflows.length && active === 0) {
          return resolve();
        }
        while (active < this.maxWorkers && idx < workflows.length) {
          const workflow = workflows[idx++];
          active++;
          // Resolve correct worker file depending on runtime (ts-node/tsx vs compiled JS)
          const isProd = import.meta.url.endsWith('.js');
          const workerFile = isProd
            ? new URL('worker.js', import.meta.url)
            : new URL('./worker.ts', import.meta.url);

          const worker = new Worker(workerFile, {
            name: `worker-${workflow.ipfs_hash}`,
            workerData: {
              workflow,
              accessToken: reportingClient.getAccessToken(),
              refreshToken: reportingClient.getRefreshToken(),
            },
            ...(!isProd && { execArgv: ['--loader', 'tsx'] }),
          });
          logger.info(
            `Spawning worker for ${workflow.ipfs_hash} with token: ${reportingClient.getAccessToken() ? 'present' : 'absent'}`,
          );
          worker.on('message', (result) => {
            if (result && result.error) {
              logger.error({
                workflow: workflow.ipfs_hash,
                error: result.error.message,
                stack: result.error.stack,
              }, 'Worker error');
            }
          });
          worker.on('error', (err) => {
            logger.error({ workflow: workflow.ipfs_hash, error: err }, 'Worker thread error');
          });
          worker.on('exit', (code) => {
            if (code !== 0) {
              logger.error({
                workflow: workflow.ipfs_hash
              }, `Worker stopped with exit code ${code}`);
            }
            active--;
            next();
          });
        }
      };
      next();
    });
  }

  async ensureNextSimTime(workflows: Workflow[]): Promise<void> {
    if (workflows.length === 0) return;

    logger.info(`Ensuring next_simulation_time for ${workflows.length} workflows...`);

    for (const workflow of workflows) {
      try {
        const nextTime = getNextSimulationTime(workflow);
        await this.db.updateWorkflow(workflow.ipfs_hash, { next_simulation_time: nextTime });
        if (nextTime) {
          logger.info(`Set next_simulation_time for workflow ${workflow.ipfs_hash}: ${nextTime.toISOString()}`);
        } else {
          logger.info(`Workflow ${workflow.ipfs_hash} has no triggers and will run once.`);
        }
      } catch (e) {
        const err = e as Error;
        logger.warn(`Failed to set next_simulation_time for workflow ${workflow.ipfs_hash}: ${err.message}`);
      }
    }
  }

  async getCurrentBlockNumbers(chainIds: Set<number>): Promise<void> {
    // Use cache for same execution cycle, clear cache each cycle
    this.blockNumberCache.clear();

    logger.info(`Fetching current block numbers for chains: ${Array.from(chainIds).join(', ')}`);

    for (const chainId of chainIds) {
      if (!this.supportedChains.includes(chainId)) {
        logger.warn(`Skipping unsupported chain ${chainId}`);
        continue;
      }

      try {
        const blockNumber = await this.eventMonitor.getCurrentBlockNumber(chainId);
        this.blockNumberCache.set(chainId, blockNumber);
        logger.info(`Chain ${chainId}: Current block ${blockNumber}`);
      } catch (error) {
        const err = error as Error;
        logger.warn(`Failed to get block number for chain ${chainId}: ${err.message}`);
      }
    }
  }

  extractChainsFromTriggers(workflows: Workflow[]): Set<number> {
    const chainIds: Set<number> = new Set();

    for (const workflow of workflows) {
      for (const trigger of workflow.triggers) {
        if (trigger.type === TRIGGER_TYPE.EVENT) {
          // Extract from raw trigger format
          const chainId = (trigger.params as any)?.chainId || CHAIN_IDS.SEPOLIA;
          chainIds.add(chainId);
        }
      }
    }

    return chainIds;
  }

  async ensureEventTriggersSetUp(workflows: Workflow[]): Promise<void> {
    if (workflows.length === 0) return;

    logger.info(`Setting up event triggers for ${workflows.length} workflows...`);

    // Extract all unique chain IDs from all workflows
    const requiredChainIds = this.extractChainsFromTriggers(workflows);

    if (requiredChainIds.size === 0) {
      logger.info(`No event triggers found, skipping event setup`);
      return;
    }

    // Fetch current block numbers once for all chains
    await this.getCurrentBlockNumbers(requiredChainIds);

    // Initialize block tracking for each workflow with ALL found chain IDs
    for (const workflow of workflows) {
      try {
        await this.initializeWorkflowEventTracking(workflow);
      } catch (error) {
        const err = error as Error;
        logger.warn(`Failed to initialize event tracking for workflow ${workflow.ipfs_hash}: ${err.message}`);
      }
    }
  }

  async ensureBlockTrackingForAll(workflows: Workflow[]): Promise<void> {
    logger.info(`Ensuring block tracking for ${workflows.length} workflows about to be processed...`);

    // Extract all unique chain IDs from event triggers in these workflows
    const requiredChainIds = this.extractChainsFromTriggers(workflows);

    if (requiredChainIds.size === 0) {
      logger.info(`No event triggers found in ready workflows, skipping block tracking setup`);
      return;
    }

    // Get current block numbers for required chains (fetch fresh if not cached)
    for (const chainId of requiredChainIds) {
      if (!this.blockNumberCache.has(chainId)) {
        if (!this.supportedChains.includes(chainId)) {
          logger.warn(`Skipping unsupported chain ${chainId}`);
          continue;
        }

        try {
          const blockNumber = await this.eventMonitor.getCurrentBlockNumber(chainId);
          this.blockNumberCache.set(chainId, blockNumber);
          logger.info(`Chain ${chainId}: Fetched current block ${blockNumber}`);
        } catch (error) {
          const err = error as Error;
          logger.warn(`Failed to get block number for chain ${chainId}: ${err.message}`);
        }
      }
    }

    // Initialize block tracking for workflows that need it
    for (const workflow of workflows) {
      try {
        await this.initializeWorkflowEventTracking(workflow);
      } catch (error) {
        const err = error as Error;
        logger.warn(`Failed to initialize event tracking for workflow ${workflow.ipfs_hash}: ${err.message}`);
      }
    }
  }

  async initializeWorkflowEventTracking(workflow: Workflow): Promise<void> {
    const blockTracking = workflow.block_tracking || {};
    let hasUpdates = false;

    // Determine chains this workflow actually uses
    const workflowChainIds = this.extractChainsFromTriggers([workflow]);

    for (const chainId of workflowChainIds) {
      const chainKey = `chain_${chainId}`;

      // Skip if already initialized
      if (blockTracking[chainKey]) continue;

      // Use cached block number
      const currentBlock = this.blockNumberCache.get(chainId);
      if (!currentBlock) {
        logger.warn(`No cached block number for chain ${chainId}, skipping`);
        continue;
      }

      // Initialize tracking for this chain
      blockTracking[chainKey] = {
        last_processed_block: currentBlock,
        last_updated: new Date(),
      };

      hasUpdates = true;
      logger.info(
        `Initialized chain ${chainId} tracking for workflow ${workflow.ipfs_hash} at block ${currentBlock}`,
      );
    }

    // Update workflow if we made changes
    if (hasUpdates) {
      await this.db.updateWorkflow(workflow.ipfs_hash, { block_tracking: blockTracking });
      logger.debug(`Updated block tracking for ${workflow.ipfs_hash}: ${JSON.stringify(blockTracking)}`);
    }
  }

  async run() {
    await this.db.connect();
    let isSetInterval = false;
    
    try {
      while (true) {
        logger.info('Checking for unsynced chains');
        const unsyncedChainsCount = await this.db.getUnsyncedChainsCount();
        if (unsyncedChainsCount > 0) {
          logger.info(`${unsyncedChainsCount} chains are not synced. Waiting...`);
          await new Promise((res) => setTimeout(res, this.chainSyncCheckInterval));
          continue;
        }

        await reportingClient.initialize();
        try {
          this.eventMonitor.updateAccessToken(reportingClient.getAccessToken() || undefined);
        } catch {}
        if (!isSetInterval) {
          setInterval(() => {
          reportingClient.doRefreshToken().catch(err => {
            logger.error({ error: err }, 'Failed to refresh token in background');
          });
          }, this.tokenRefreshInterval);
          isSetInterval = true;
        }

        logger.info('Checking for workflows with missing next_simulation_time');

        // 1. Ensure workflows have next_simulation_time
        const missingNextTime = await this.db.getWorkflowsMissingNextSimulationTime(20);
        logger.info(`Found ${missingNextTime.length} workflows with missing next_simulation_time`);
        if (missingNextTime.length > 0) {
          await this.ensureNextSimTime(missingNextTime);
          await this.ensureEventTriggersSetUp(missingNextTime);
        }

        // 2. Process ready workflows with workers
        const workflows = await this.db.getRelevantWorkflows();
        logger.debug(`Gathered ${workflows.length} workflows for processing.`);

        // 2.5. Ensure block tracking for ALL workflows about to be processed
        if (workflows.length > 0) {
          logger.info('Ensuring block tracking for all workflows');
          await this.ensureBlockTrackingForAll(workflows);

          // 2.6. Reload workflows from DB to get updated block tracking
          const workflowHashes = workflows.map((w) => w.ipfs_hash);
          const updatedWorkflows = await this.db.getWorkflowsByHashes(workflowHashes);
          logger.debug(`Reloaded ${updatedWorkflows.length} workflows with updated block tracking.`);

          // Debug: Check if workflows actually have block tracking now
          updatedWorkflows.forEach((w) => {
            const blockTracking = w.block_tracking || {};
            const chainKeys = Object.keys(blockTracking);
            logger.debug(
              `Workflow ${w.ipfs_hash} block_tracking: ${chainKeys.length} chains - ${JSON.stringify(blockTracking)}`,
            );
          });

          logger.info('Processing workflows with workers');
          await this.processWithWorkers(updatedWorkflows);
        } else {
          await this.processWithWorkers(workflows);
        }

        // 3. Sleep before next cycle
        await new Promise((res) => setTimeout(res, this.sleep));
      }
    } catch (err) {
      logger.error({ error: err }, 'Error in main loop');
    } finally {
      await this.db.close();
    }
  }
}

// Entry point
let simulator: Simulator | null = null;
if (!isSandboxMode) {
  simulator = new Simulator();
}

const app = express();

// Add request logging middleware
app.use((req, res, next) => {
  logger.info({ method: req.method, url: req.url, ip: req.ip }, 'Incoming request');
  next();
});

// Configure body parser with larger limit for WASM payloads (12MB to match server.ts MAX_BODY_BYTES)
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? String(12 * 1024 * 1024)); // 12MB
app.use(bodyParser.json({ limit: MAX_BODY_BYTES }));

// Only use validateRouter if not in sandbox mode (it requires DB)
if (!isSandboxMode) {
  app.use(validateRouter);
}

// Get config - for sandbox mode, provide minimal config
let apiOnly: boolean;
let httpPort: number;
let wasmServerUrl: string | undefined;

if (isSandboxMode) {
  // Sandbox mode: minimal config without DB dependencies
  apiOnly = true;
  httpPort = parseInt(process.env.HTTP_PORT || '8080', 10);
  wasmServerUrl = process.env.WASM_SERVER_URL || undefined;
} else {
  const config = getConfig();
  apiOnly = config.apiOnly;
  httpPort = config.httpPort;
  wasmServerUrl = config.wasmServerUrl;
}

// Integrate WASM server endpoints if not using external WASM server
// This allows operators to use the same server for both validation API and WASM execution
if (!wasmServerUrl) {
  app.get('/wasm/health', wasmHealthHandler);
  app.post('/wasm/run', wasmRunHandler);
  if (isSandboxMode) {
    logger.info('WASM sandbox server started');
    logger.info('  - GET /wasm/health - Health check');
    logger.info('  - POST /wasm/run - Execute WASM code');
  } else {
    logger.info('WASM server endpoints integrated into main Express app at /wasm/*');
    logger.info('  - GET /wasm/health - Health check');
    logger.info('  - POST /wasm/run - Execute WASM code');
  }
} else {
  logger.info(`Using external WASM server: ${wasmServerUrl}`);
}

// RPC proxy endpoint for WASM sandbox (only on simulator, not sandbox itself)
if (!isSandboxMode) {
  const { getRpcSimulator } = await import('./utils/rpcSimulator.js');
  
  app.post('/rpc/proxy', async (req, res) => {
    logger.info({ method: req.method, url: req.url, bodyKeys: Object.keys(req.body || {}) }, 'RPC proxy request received');
    try {
      const simulator = getRpcSimulator();
      const response = await simulator.execute(req.body);
      logger.info({ method: req.body?.method, hasError: !!response.error }, 'RPC proxy response');
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'RPC proxy error');
      res.status(500).json({
        jsonrpc: '2.0',
        id: req.body?.id ?? null,
        error: { code: -32000, message: 'RPC proxy error', data: (error as Error).message }
      });
    }
  });
  logger.info('RPC proxy endpoint available at POST /rpc/proxy');
}

// Catch-all 404 handler (after all routes)
app.use((req, res) => {
  logger.warn({ method: req.method, url: req.url }, '404 - Route not found');
  res.status(404).json({ error: 'Not found', path: req.url });
});

let isShuttingDown = false;
async function gracefulShutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (isSandboxMode) {
    logger.info({ signal }, 'Received shutdown signal. Shutting down sandbox...');
  } else {
    logger.info({ signal }, 'Received shutdown signal. Unregistering operator...');
    try {
      await reportingClient.unregisterOperator();
    } catch {}
  }
  // Exit after unregister attempt
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

app.listen(httpPort, () => {
  if (isSandboxMode) {
    logger.info(`WASM sandbox server listening on port ${httpPort}`);
  } else {
    logger.info(`HTTP server listening on port ${httpPort}`);
  }
});

if (!isSandboxMode && !apiOnly) {
  simulator!.run();
} else if (isSandboxMode) {
  logger.info('Sandbox mode: Only WASM endpoints are available.');
} else {
  logger.info('API_ONLY mode enabled. Simulator loop is not running.');
}
