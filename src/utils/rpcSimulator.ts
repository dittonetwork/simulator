/**
 * RPC Simulator - Provides read-only EVM JSON-RPC methods
 * 
 * This simulator wraps viem's PublicClient to provide read-only JSON-RPC methods
 * for guest WASM modules. All write/state-changing methods are rejected.
 */

import { createPublicClient, http, type PublicClient, type Address, type Hex } from 'viem';
import { mainnet, sepolia, baseSepolia, base } from 'viem/chains';
import { getLogger } from '../logger.js';
import { authHttpConfig } from './httpTransport.js';

const logger = getLogger('RpcSimulator');

/**
 * Allowed read-only JSON-RPC methods
 */
const ALLOWED_METHODS = new Set([
  'eth_call',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_blockNumber',
  'eth_chainId',
  'net_version',
  'web3_clientVersion',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_estimateGas', // Read-only, doesn't change state
] as const);

/**
 * Write/state-changing methods that must be rejected
 */
const DISALLOWED_METHODS = new Set([
  'eth_sendTransaction',
  'eth_sendRawTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_accounts',
  'personal_sign',
  'personal_sendTransaction',
  'eth_mining',
  'eth_submitHashrate',
  'eth_submitWork',
] as const);

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown[];
  chainId?: number; // Optional: specify which chain to query (non-standard extension)
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface RpcSimulator {
  /**
   * Execute a JSON-RPC request and return the response
   */
  execute(request: JsonRpcRequest): Promise<JsonRpcResponse>;
}

/**
 * Default RPC Simulator implementation using viem PublicClient
 */
export class DefaultRpcSimulator implements RpcSimulator {
  private clients: Map<number, PublicClient> = new Map();
  private defaultChainId: number = 0;

  constructor() {
    // Minimal config - read RPC URLs directly from env vars (no getConfig() needed)
    // This allows sandbox to work without full simulator config
    const chainConfigs: { id: number; chain: any; envKey: string }[] = [
      { id: 1, chain: mainnet, envKey: 'RPC_URL_1' },
      { id: 11155111, chain: sepolia, envKey: 'RPC_URL_11155111' },
      { id: 84532, chain: baseSepolia, envKey: 'RPC_URL_84532' },
      { id: 8453, chain: base, envKey: 'RPC_URL_8453' },
    ];

    const configuredChains: string[] = [];
    for (const { id, chain, envKey } of chainConfigs) {
      const rpcUrl = process.env[envKey];
      if (rpcUrl) {
        this.clients.set(
          id,
          createPublicClient({
            chain,
            transport: http(rpcUrl, authHttpConfig()),
          }) as PublicClient
        );
        configuredChains.push(`${id}=${rpcUrl.substring(0, 30)}...`);
        if (!this.defaultChainId) {
          this.defaultChainId = id;
        }
      }
    }

    if (this.clients.size === 0) {
      logger.warn('RpcSimulator: No RPC URLs configured! Set RPC_URL_1, RPC_URL_11155111, etc.');
      this.defaultChainId = 1; // fallback
    } else {
      logger.info({ configuredChains, defaultChainId: this.defaultChainId }, `RpcSimulator initialized with ${this.clients.size} chain(s)`);
    }
  }

  /**
   * Get client for a specific chain ID
   */
  private getClient(chainId?: number): PublicClient {
    const targetChainId = chainId || this.defaultChainId;
    const client = this.clients.get(targetChainId);
    
    if (!client) {
      throw new Error(`No RPC client configured for chain ${targetChainId}. Set RPC_URL_${targetChainId} env var.`);
    }
    
    return client;
  }

  /**
   * Validate that a method is allowed (read-only)
   */
  private validateMethod(method: string): void {
    if (DISALLOWED_METHODS.has(method as any)) {
      throw new Error(`Method ${method} is not allowed (write operation)`);
    }
    if (!ALLOWED_METHODS.has(method as any)) {
      throw new Error(`Method ${method} not found or not supported`);
    }
  }

  /**
   * Execute a JSON-RPC request
   */
  async execute(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    // Validate JSON-RPC format
    if (request.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      };
    }

    if (!request.method || typeof request.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      };
    }

    try {
      // Validate method is allowed
      this.validateMethod(request.method);

      // Use chainId from request if provided, otherwise use default
      const chainId = request.chainId ?? this.defaultChainId;
      
      logger.info({ method: request.method, chainId }, 'Calling external RPC');
      
      // Execute the method with the specified chainId
      const result = await this.executeMethod(request.method, request.params || [], chainId);

      logger.info({ method: request.method, chainId, resultPreview: JSON.stringify(result).substring(0, 100) }, 'External RPC call completed');
      
      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };
    } catch (error) {
      const err = error as Error;
      logger.error({ method: request.method, error: err }, 'RPC method execution failed');

      // Return appropriate JSON-RPC error
      if (err.message.includes('not allowed') || err.message.includes('not found')) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32601,
            message: 'Method not found',
            data: err.message,
          },
        };
      }

      if (err.message.includes('Invalid params')) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32602,
            message: 'Invalid params',
            data: err.message,
          },
        };
      }

      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32000,
          message: 'Server error',
          data: err.message,
        },
      };
    }
  }

  /**
   * Execute a specific RPC method
   */
  private async executeMethod(method: string, params: unknown[], chainId?: number): Promise<unknown> {
    const client = this.getClient(chainId);

    switch (method) {
      case 'eth_blockNumber': {
        const blockNumber = await client.getBlockNumber();
        return `0x${blockNumber.toString(16)}`;
      }

      case 'eth_chainId': {
        const chainId = await client.getChainId();
        return `0x${chainId.toString(16)}`;
      }

      case 'net_version': {
        const chainId = await client.getChainId();
        return chainId.toString();
      }

      case 'web3_clientVersion': {
        return 'ditto-simulator/1.0.0';
      }

      case 'eth_getBalance': {
        if (params.length < 1) {
          throw new Error('Invalid params: eth_getBalance requires address');
        }
        const address = params[0] as Address;
        const blockTag = params[1] as 'latest' | 'earliest' | 'pending' | Hex | undefined;
        const balance = await client.getBalance({
          address,
          blockTag: blockTag as any,
        });
        return `0x${balance.toString(16)}`;
      }

      case 'eth_getTransactionCount': {
        if (params.length < 1) {
          throw new Error('Invalid params: eth_getTransactionCount requires address');
        }
        const address = params[0] as Address;
        const blockTag = params[1] as 'latest' | 'earliest' | 'pending' | Hex | undefined;
        const count = await client.getTransactionCount({
          address,
          blockTag: blockTag as any,
        });
        return `0x${count.toString(16)}`;
      }

      case 'eth_getCode': {
        if (params.length < 1) {
          throw new Error('Invalid params: eth_getCode requires address');
        }
        const address = params[0] as Address;
        const blockTag = params[1] as 'latest' | 'earliest' | 'pending' | Hex | undefined;
        const code = await client.getBytecode({
          address,
          blockTag: blockTag as any,
        });
        return code || '0x';
      }

      case 'eth_getStorageAt': {
        if (params.length < 2) {
          throw new Error('Invalid params: eth_getStorageAt requires address and position');
        }
        const address = params[0] as Address;
        const position = params[1] as Hex;
        const blockTag = params[2] as 'latest' | 'earliest' | 'pending' | Hex | undefined;
        const storage = await client.getStorageAt({
          address,
          slot: position,
          blockTag: blockTag as any,
        });
        return storage || '0x0000000000000000000000000000000000000000000000000000000000000000';
      }

      case 'eth_call': {
        if (params.length < 1) {
          throw new Error('Invalid params: eth_call requires transaction object');
        }
        const tx = params[0] as {
          to?: Address;
          data?: Hex;
          value?: Hex;
          gas?: Hex;
          gasPrice?: Hex;
        };
        const blockTag = params[1] as 'latest' | 'earliest' | 'pending' | Hex | undefined;

        const result = await client.call({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
          gasPrice: tx.gasPrice ? BigInt(tx.gasPrice) : undefined,
          blockTag: blockTag as any,
        });
        return result.data || '0x';
      }

      case 'eth_estimateGas': {
        if (params.length < 1) {
          throw new Error('Invalid params: eth_estimateGas requires transaction object');
        }
        const tx = params[0] as {
          to?: Address;
          data?: Hex;
          value?: Hex;
          from?: Address;
        };
        const blockTag = params[1] as 'latest' | 'earliest' | 'pending' | Hex | undefined;

        const gas = await client.estimateGas({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          account: tx.from,
          blockTag: blockTag as any,
        });
        return `0x${gas.toString(16)}`;
      }

      case 'eth_getBlockByNumber': {
        if (params.length < 1) {
          throw new Error('Invalid params: eth_getBlockByNumber requires block number');
        }
        const blockNumber = params[0] as 'latest' | 'earliest' | 'pending' | Hex;
        const includeTransactions = params[1] === true;

        const block = await client.getBlock({
          blockNumber: blockNumber as any,
          includeTransactions,
        }) as any;

        if (!block) {
          return null;
        }

        return {
          number: `0x${block.number.toString(16)}`,
          hash: block.hash,
          parentHash: block.parentHash,
          timestamp: `0x${block.timestamp.toString(16)}`,
          transactions: includeTransactions ? block.transactions : block.transactions.map((tx: any) => (typeof tx === 'string' ? tx : tx.hash)),
        };
      }

      case 'eth_getBlockByHash': {
        if (params.length < 1) {
          throw new Error('Invalid params: eth_getBlockByHash requires block hash');
        }
        const blockHash = params[0] as Hex;
        const includeTransactions = params[1] === true;

        const block = await client.getBlock({
          blockHash,
          includeTransactions,
        }) as any;

        if (!block) {
          return null;
        }

        return {
          number: `0x${block.number.toString(16)}`,
          hash: block.hash,
          parentHash: block.parentHash,
          timestamp: `0x${block.timestamp.toString(16)}`,
          transactions: includeTransactions ? block.transactions : block.transactions.map((tx: any) => (typeof tx === 'string' ? tx : tx.hash)),
        };
      }

      case 'eth_getTransactionByHash': {
        if (params.length < 1) {
          throw new Error('Invalid params: eth_getTransactionByHash requires transaction hash');
        }
        const txHash = params[0] as Hex;
        const tx = await client.getTransaction({ hash: txHash });
        
        if (!tx) {
          return null;
        }

        return {
          hash: tx.hash,
          nonce: `0x${tx.nonce.toString(16)}`,
          blockHash: tx.blockHash,
          blockNumber: tx.blockNumber ? `0x${tx.blockNumber.toString(16)}` : null,
          transactionIndex: tx.transactionIndex !== null ? `0x${tx.transactionIndex.toString(16)}` : null,
          from: tx.from,
          to: tx.to,
          value: `0x${tx.value.toString(16)}`,
          gas: `0x${tx.gas.toString(16)}`,
          gasPrice: tx.gasPrice ? `0x${tx.gasPrice.toString(16)}` : null,
          input: tx.input,
        };
      }

      case 'eth_getTransactionReceipt': {
        if (params.length < 1) {
          throw new Error('Invalid params: eth_getTransactionReceipt requires transaction hash');
        }
        const txHash = params[0] as Hex;
        const receipt = await client.getTransactionReceipt({ hash: txHash });
        
        if (!receipt) {
          return null;
        }

        return {
          transactionHash: receipt.transactionHash,
          transactionIndex: `0x${receipt.transactionIndex.toString(16)}`,
          blockHash: receipt.blockHash,
          blockNumber: `0x${receipt.blockNumber.toString(16)}`,
          from: receipt.from,
          to: receipt.to,
          gasUsed: `0x${receipt.gasUsed.toString(16)}`,
          cumulativeGasUsed: `0x${receipt.cumulativeGasUsed.toString(16)}`,
          contractAddress: receipt.contractAddress,
          logs: receipt.logs,
          status: `0x${(typeof receipt.status === 'bigint' ? Number(receipt.status) : receipt.status).toString(16)}`,
        };
      }

      default:
        throw new Error(`Method ${method} not implemented`);
    }
  }
}

// Singleton instance
let simulatorInstance: RpcSimulator | null = null;

/**
 * Get or create the RPC simulator instance
 */
export function getRpcSimulator(): RpcSimulator {
  if (!simulatorInstance) {
    simulatorInstance = new DefaultRpcSimulator();
  }
  return simulatorInstance;
}

