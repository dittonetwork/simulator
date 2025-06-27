import { createPublicClient, http, parseAbiItem } from 'viem';
import { sepolia, mainnet } from 'viem/chains';
import dotenv from 'dotenv';
dotenv.config();

/**
 * EventMonitor handles checking for blockchain events that trigger workflow execution
 */
export class EventMonitor {
    constructor() {
        this.clients = new Map();
        this.maxBlockRanges = this.loadMaxBlockRanges();
        this.setupClients();
    }

    /**
     * Load max block ranges from environment variables
     */
    loadMaxBlockRanges() {
        const ranges = new Map();
        // Load max block ranges for different chains
        ranges.set(11155111, parseInt(process.env.MAX_BLOCK_RANGE_11155111 || '10000')); // Sepolia
        ranges.set(1, parseInt(process.env.MAX_BLOCK_RANGE_1 || '2000')); // Mainnet
        return ranges;
    }

    /**
     * Setup RPC clients for different chains
     */
    setupClients() {
        // Sepolia client
        if (process.env.RPC_URL) {
            this.clients.set(11155111, createPublicClient({
                chain: sepolia,
                transport: http(process.env.RPC_URL)
            }));
        }

        // Mainnet client (if needed)
        if (process.env.MAINNET_RPC_URL) {
            this.clients.set(1, createPublicClient({
                chain: mainnet,
                transport: http(process.env.MAINNET_RPC_URL)
            }));
        }
    }

    /**
     * Get current block number for a chain
     */
    async getCurrentBlockNumber(chainId) {
        const client = this.clients.get(chainId);
        if (!client) {
            throw new Error(`No RPC client configured for chain ${chainId}`);
        }

        const blockNumber = await client.getBlockNumber();
        return Number(blockNumber);
    }

    /**
     * Generate unique key for event trigger
     */
    generateTriggerKey(eventTrigger, triggerIndex) {
        // Use trigger index + signature + chainId for unique identification
        const signature = eventTrigger.signature?.split('(')[0] || 'unknown'; // Just the event name
        const chainId = eventTrigger.chainId || 11155111;
        return `trigger_${triggerIndex}_${signature}_${chainId}`;
    }

    /**
     * Generate trigger key from raw trigger format (from database)
     */
    generateTriggerKeyFromRaw(rawTrigger, triggerIndex) {
        const signature = rawTrigger.params?.signature?.split('(')[0] || 'unknown';
        const chainId = rawTrigger.params?.chainId || 11155111;
        return `trigger_${triggerIndex}_${signature}_${chainId}`;
    }

    /**
     * Initialize last processed block for a specific event trigger if not exists
     */
    async initializeLastProcessedBlock(workflow, eventTrigger, triggerIndex, db) {
        const chainId = eventTrigger.chainId || 11155111;
        const currentBlock = await this.getCurrentBlockNumber(chainId);
        const triggerKey = this.generateTriggerKey(eventTrigger, triggerIndex);

        // Initialize block tracking for this specific trigger if not exists
        const blockTracking = workflow.block_tracking || {};
        if (!blockTracking[triggerKey]) {
            blockTracking[triggerKey] = {
                signature: eventTrigger.signature,
                chainId: chainId,
                address: eventTrigger.address || eventTrigger.filter?.address,
                last_processed_block: currentBlock,
                last_updated: new Date()
            };

            console.log(`[EventMonitor] Initialized last_processed_block for trigger "${eventTrigger.signature}" on chain ${chainId}: ${currentBlock}`);

            // Update workflow in database
            await db.updateWorkflow(workflow.ipfs_hash, {
                block_tracking: blockTracking
            });

            workflow.block_tracking = blockTracking;
        }

        return blockTracking[triggerKey].last_processed_block;
    }

    /**
     * Update last processed block for a specific event trigger
     */
    async updateLastProcessedBlock(workflow, eventTrigger, triggerIndex, blockNumber, db) {
        const triggerKey = this.generateTriggerKey(eventTrigger, triggerIndex);
        const blockTracking = workflow.block_tracking || {};

        if (!blockTracking[triggerKey]) {
            blockTracking[triggerKey] = {
                signature: eventTrigger.signature,
                chainId: eventTrigger.chainId || 11155111,
                address: eventTrigger.address || eventTrigger.filter?.address
            };
        }

        blockTracking[triggerKey].last_processed_block = blockNumber;
        blockTracking[triggerKey].last_updated = new Date();

        await db.updateWorkflow(workflow.ipfs_hash, {
            block_tracking: blockTracking
        });

        workflow.block_tracking = blockTracking;

        console.log(`[EventMonitor] Updated last_processed_block for trigger "${eventTrigger.signature}": ${blockNumber}`);
    }

    /**
     * Split large block ranges into chunks
     */
    splitBlockRange(fromBlock, toBlock, maxChunkSize) {
        const chunks = [];
        let currentStart = fromBlock;

        while (currentStart <= toBlock) {
            const currentEnd = Math.min(currentStart + maxChunkSize - 1, toBlock);
            chunks.push({ fromBlock: currentStart, toBlock: currentEnd });
            currentStart = currentEnd + 1;
        }

        return chunks;
    }

    /**
     * Query events for a specific block range and event configuration
     */
    async queryEventsInRange(chainId, eventConfig, fromBlock, toBlock) {
        const client = this.clients.get(chainId);
        if (!client) {
            throw new Error(`No RPC client configured for chain ${chainId}`);
        }

        try {
            // Parse the event signature to create ABI item
            const abiItem = parseAbiItem(`event ${eventConfig.signature}`);

            // Build filter parameters
            const filterParams = {
                event: abiItem,
                fromBlock: BigInt(fromBlock),
                toBlock: BigInt(toBlock)
            };

            // Add contract address - check multiple possible locations
            const contractAddress = eventConfig.address || eventConfig.filter?.address;
            if (contractAddress) {
                filterParams.address = contractAddress;
                console.log(`[EventMonitor] Filtering by contract address: ${contractAddress}`);
            }

            // Add indexed parameter filters if specified (excluding address field)
            if (eventConfig.filter && Object.keys(eventConfig.filter).length > 0) {
                const args = {};
                Object.keys(eventConfig.filter).forEach(key => {
                    if (key !== 'address') {
                        args[key] = eventConfig.filter[key];
                    }
                });
                if (Object.keys(args).length > 0) {
                    filterParams.args = args;
                    console.log(`[EventMonitor] Applying event filters:`, args);
                }
            }

            console.log(`[EventMonitor] === ETH_GETLOGS CALL ===`);
            console.log(`[EventMonitor] Chain: ${chainId}`);
            console.log(`[EventMonitor] Event signature: ${eventConfig.signature}`);

            // Build JSON-RPC params in the same format as your curl example
            const rpcParams = {
                address: contractAddress,
                fromBlock: `0x${fromBlock.toString(16)}`,
                toBlock: `0x${toBlock.toString(16)}`
            };

            // Build topics array manually to show the raw format
            let topics = [];

            // First topic is always the event signature hash (keccak256 of signature)
            // For Transfer event: keccak256("Transfer(address,address,uint256)")
            topics.push("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");

            // Add indexed parameter filters if specified
            if (filterParams.args) {
                if (filterParams.args.from !== undefined) {
                    // Convert address to 32-byte hex (pad with zeros)
                    const fromAddr = filterParams.args.from;
                    if (fromAddr === "0x0000000000000000000000000000000000000000") {
                        topics.push("0x0000000000000000000000000000000000000000000000000000000000000000");
                    } else {
                        topics.push(`0x000000000000000000000000${fromAddr.slice(2).toLowerCase()}`);
                    }
                }
                if (filterParams.args.to !== undefined) {
                    // Convert address to 32-byte hex (pad with zeros)  
                    const toAddr = filterParams.args.to;
                    topics.push(`0x000000000000000000000000${toAddr.slice(2).toLowerCase()}`);
                }
            }

            if (topics.length > 0) {
                rpcParams.topics = topics;
            }

            console.log(`[EventMonitor] Raw JSON-RPC call params (like your curl):`, JSON.stringify(rpcParams, null, 2));

            const logs = await client.getLogs(filterParams);

            console.log(`[EventMonitor] === ETH_GETLOGS RESPONSE ===`);
            console.log(`[EventMonitor] Found ${logs.length} events in range ${fromBlock}-${toBlock}`);
            if (logs.length > 0) {
                console.log(`[EventMonitor] Sample event:`, {
                    address: logs[0].address,
                    blockNumber: logs[0].blockNumber?.toString(),
                    transactionHash: logs[0].transactionHash,
                    topics: logs[0].topics
                });
            }
            console.log(`[EventMonitor] ============================`);

            return logs;

        } catch (error) {
            console.error(`[EventMonitor] Error querying events:`, error);
            throw error;
        }
    }

    /**
     * Check if any events were emitted for a workflow's event triggers
     */
    async checkEventTriggers(workflow, db) {
        console.log(`[EventMonitor] Checking event triggers for workflow ${workflow.getIpfsHashShort()}`);

        // Work with raw triggers from workflow meta
        const triggers = workflow.meta?.workflow?.triggers || workflow.triggers;
        const eventTriggers = triggers.filter(trigger => trigger.type === 'event');
        if (eventTriggers.length === 0) {
            console.log(`[EventMonitor] No event triggers found, skipping event check`);
            return true; // No event triggers, proceed normally
        }

        // Group triggers by chain ID
        const triggersByChain = new Map();
        eventTriggers.forEach((trigger, index) => {
            const chainId = trigger.params?.chainId || 11155111;
            if (!triggersByChain.has(chainId)) {
                triggersByChain.set(chainId, []);
            }
            triggersByChain.get(chainId).push({ trigger, index });
        });

        let anyEventFound = false;
        const eventResults = [];

        // Process each chain
        for (const [chainId, chainTriggers] of triggersByChain) {
            try {
                // Get current block and last processed block for this chain
                const currentBlock = await this.getCurrentBlockNumber(chainId);
                const chainKey = `chain_${chainId}`;

                let lastProcessedBlock = workflow.block_tracking?.[chainKey]?.last_processed_block;

                // Debug: Show what block tracking data we actually have
                console.debug(`[EventMonitor] Workflow ${workflow.getIpfsHashShort()} block_tracking: ${JSON.stringify(workflow.block_tracking || {})}`);
                console.debug(`[EventMonitor] Looking for chainKey: ${chainKey}, found: ${lastProcessedBlock || 'NOT FOUND'}`);

                if (!lastProcessedBlock) {
                    // Block tracking should have been initialized by main loop
                    console.error(`[EventMonitor] Chain ${chainId} not initialized for workflow ${workflow.getIpfsHashShort()}! This should have been handled by main loop.`);

                    // Add error results for all triggers on this chain
                    chainTriggers.forEach(({ trigger, index }) => {
                        eventResults.push({
                            triggerIndex: index,
                            chainId,
                            signature: trigger.params?.signature || 'unknown',
                            error: `Chain ${chainId} block tracking not initialized`,
                            fromBlock: null,
                            toBlock: null,
                            blocksChecked: 0
                        });
                    });
                    continue;
                }

                // If blocks are the same, no new blocks to process
                if (lastProcessedBlock >= currentBlock) {
                    console.log(`[EventMonitor] Chain ${chainId}: No new blocks to process (last: ${lastProcessedBlock}, current: ${currentBlock})`);
                    chainTriggers.forEach(({ trigger, index }) => {
                        eventResults.push({
                            triggerIndex: index,
                            chainId,
                            signature: trigger.params?.signature || 'unknown',
                            eventsFound: 0,
                            blocksChecked: 0,
                            fromBlock: lastProcessedBlock,
                            toBlock: currentBlock,
                            lastBlock: lastProcessedBlock
                        });
                    });
                    continue;
                }

                const maxChunkSize = this.maxBlockRanges.get(chainId) || 10000;
                const totalBlocks = currentBlock - lastProcessedBlock;

                console.log(`[EventMonitor] Chain ${chainId}: Checking ${totalBlocks} blocks (${lastProcessedBlock + 1} to ${currentBlock}) for ${chainTriggers.length} triggers`);

                // Split into chunks if range is too large
                const chunks = this.splitBlockRange(lastProcessedBlock + 1, currentBlock, maxChunkSize);
                console.log(`[EventMonitor] Split into ${chunks.length} chunks (max chunk size: ${maxChunkSize})`);

                // Process each trigger on this chain
                for (const { trigger, index } of chainTriggers) {
                    const signature = trigger.params?.signature;
                    if (!signature) {
                        eventResults.push({
                            triggerIndex: index,
                            chainId,
                            signature: 'unknown',
                            error: 'Missing event signature in trigger params',
                            fromBlock: null,
                            toBlock: null,
                            blocksChecked: 0
                        });
                        continue;
                    }

                    let totalEventsFound = 0;

                    // Create event config for querying
                    const eventConfig = {
                        signature,
                        filter: trigger.params?.filter || {},
                        address: trigger.params?.address || trigger.params?.contractAddress
                    };

                    // Process each chunk for this trigger
                    for (const chunk of chunks) {
                        console.log(`[EventMonitor] Processing trigger "${signature}" chunk ${chunk.fromBlock}-${chunk.toBlock}`);

                        const events = await this.queryEventsInRange(
                            chainId,
                            eventConfig,
                            chunk.fromBlock,
                            chunk.toBlock
                        );

                        totalEventsFound += events.length;

                        if (events.length > 0) {
                            anyEventFound = true;
                            console.log(`[EventMonitor] Trigger "${signature}": Found ${events.length} events in chunk ${chunk.fromBlock}-${chunk.toBlock}`);
                        } else {
                            console.log(`[EventMonitor] Trigger "${signature}": No events found in chunk ${chunk.fromBlock}-${chunk.toBlock}`);
                        }
                    }

                    eventResults.push({
                        triggerIndex: index,
                        chainId,
                        signature,
                        eventsFound: totalEventsFound,
                        blocksChecked: totalBlocks,
                        fromBlock: lastProcessedBlock + 1,
                        toBlock: currentBlock,
                        lastBlock: currentBlock
                    });
                }

                // Update last processed block for this chain (once per chain)
                if (!workflow.block_tracking) workflow.block_tracking = {};
                workflow.block_tracking[chainKey] = {
                    last_processed_block: currentBlock,
                    last_updated: new Date()
                };

                await db.updateWorkflow(workflow.ipfs_hash, {
                    block_tracking: workflow.block_tracking
                });

                console.log(`[EventMonitor] Updated chain ${chainId} last_processed_block to ${currentBlock}`);

            } catch (error) {
                console.error(`[EventMonitor] Error checking events on chain ${chainId}:`, error);
                // Add error results for all triggers on this chain
                triggersByChain.get(chainId).forEach(({ trigger, index }) => {
                    eventResults.push({
                        triggerIndex: index,
                        chainId,
                        signature: trigger.params?.signature || 'unknown',
                        error: error.message,
                        fromBlock: null,
                        toBlock: null,
                        blocksChecked: 0
                    });
                });
            }
        }

        console.log(`[EventMonitor] Event check summary:`, {
            totalTriggers: eventTriggers.length,
            chainsChecked: triggersByChain.size,
            anyEventFound,
            results: eventResults
        });

        return {
            hasEvents: anyEventFound,
            results: eventResults
        };
    }
}

export default EventMonitor; 