/**
 * WASM Host Bridge - Communication protocol for host function calls
 * 
 * Since the Wasmtime JS package has limited API, we use a communication protocol
 * via environment variables and files to enable host.rpc_call functionality.
 * 
 * The guest WASM module can write RPC requests to a file, and the host
 * processes them and writes responses back.
 * 
 * RPC calls can be handled in two ways:
 * 1. Direct mode: Uses local RpcSimulator (when RPC_URL_X env vars are set)
 * 2. Proxy mode: Proxies through simulator (when RPC_PROXY_URL is set)
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { getLogger } from '../logger.js';

const logger = getLogger('WasmHostBridge');

const RPC_REQUEST_FILE = 'wasm_rpc_request.json';
const RPC_RESPONSE_FILE = 'wasm_rpc_response.json';
const MAX_REQUEST_SIZE = 64 * 1024; // 64KB
const MAX_RESPONSE_SIZE = 1024 * 1024; // 1MB
const RPC_TIMEOUT_MS = 5000; // 5 seconds - network RPC calls need time

// RPC proxy URL (if set, use proxy mode instead of direct RPC)
const RPC_PROXY_URL = process.env.RPC_PROXY_URL;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown[];
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Execute RPC via proxy URL
 */
async function executeViaProxy(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (!RPC_PROXY_URL) {
    throw new Error('RPC_PROXY_URL not set');
  }

  const url = new URL(RPC_PROXY_URL);
  const isHttps = url.protocol === 'https:';
  
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(request);
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: RPC_TIMEOUT_MS,
    };

    const req = (isHttps ? https : http).request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as JsonRpcResponse);
        } catch (error) {
          reject(new Error(`Invalid JSON from proxy: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`RPC proxy timeout after ${RPC_TIMEOUT_MS}ms`));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Process RPC requests from guest WASM module
 * 
 * This function reads RPC requests from a file (written by guest),
 * processes them via the simulator (direct or proxy), and writes responses back.
 */
export async function processWasmRpcRequests(workDir: string): Promise<void> {
  const requestPath = join(workDir, RPC_REQUEST_FILE);
  const responsePath = join(workDir, RPC_RESPONSE_FILE);
  
  try {
    // Check if request file exists
    try {
      await fs.access(requestPath);
    } catch {
      // No request file, nothing to process
      return;
    }

    logger.info({ requestPath, proxyMode: !!RPC_PROXY_URL }, 'Processing RPC request');

    // Read request
    const requestData = await fs.readFile(requestPath, 'utf-8');
    logger.info(`RPC request data: ${requestData.substring(0, 200)}`);
    
    if (requestData.length > MAX_REQUEST_SIZE) {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: '2.0' as const,
        id: null,
        error: {
          code: -32600,
          message: 'Invalid Request',
          data: `Request too large (max ${MAX_REQUEST_SIZE} bytes)`,
        },
      };
      await fs.writeFile(responsePath, JSON.stringify(errorResponse), 'utf-8');
      return;
    }

    // Parse JSON-RPC request
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(requestData);
    } catch (error) {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: '2.0' as const,
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
        },
      };
      await fs.writeFile(responsePath, JSON.stringify(errorResponse), 'utf-8');
      return;
    }

    logger.info({ method: request.method, params: JSON.stringify(request.params || []).substring(0, 200) }, 'Executing RPC method');
    
    let response: JsonRpcResponse;
    
    if (RPC_PROXY_URL) {
      // Proxy mode: call simulator's /rpc/proxy endpoint
      logger.info({ proxyUrl: RPC_PROXY_URL }, 'Using RPC proxy mode');
      try {
        response = await executeViaProxy(request);
        logger.info({ method: request.method, hasError: !!response.error }, 'RPC proxy call completed');
      } catch (error) {
        logger.error({ error, method: request.method }, 'RPC proxy call failed');
        response = {
          jsonrpc: '2.0' as const,
          id: request.id ?? null,
          error: {
            code: -32000,
            message: 'Server error',
            data: (error as Error).message,
          },
        };
      }
    } else {
      // Direct mode: use local RpcSimulator
      const { getRpcSimulator } = await import('./rpcSimulator.js');
      const simulator = getRpcSimulator();
      
      // Execute with timeout
      let timedOut = false;
      const timeoutPromise = new Promise<JsonRpcResponse>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          logger.warn({ method: request.method, timeoutMs: RPC_TIMEOUT_MS }, 'RPC call timeout');
          resolve({
            jsonrpc: '2.0' as const,
            id: request.id ?? null,
            error: {
              code: -32000,
              message: 'Server error',
              data: `RPC call timeout after ${RPC_TIMEOUT_MS}ms`,
            },
          });
        }, RPC_TIMEOUT_MS);
      });

      const executePromise = simulator.execute(request);
      response = await Promise.race([executePromise, timeoutPromise]);
      
      if (!timedOut) {
        logger.info({ method: request.method, hasError: !!response.error }, 'Direct RPC call completed');
      }
    }
    logger.info(`RPC response: ${JSON.stringify(response).substring(0, 200)}`);

    // Validate response size
    const responseStr = JSON.stringify(response);
    if (responseStr.length > MAX_RESPONSE_SIZE) {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: '2.0' as const,
        id: request.id ?? null,
        error: {
          code: -32000,
          message: 'Server error',
          data: `Response too large (max ${MAX_RESPONSE_SIZE} bytes)`,
        },
      };
      await fs.writeFile(responsePath, JSON.stringify(errorResponse), 'utf-8');
      return;
    }

    // Write response
    await fs.writeFile(responsePath, responseStr, 'utf-8');

    // Clean up request file
    try {
      await fs.unlink(requestPath);
    } catch {
      // Ignore cleanup errors
    }
  } catch (error) {
    logger.error({ error }, 'Failed to process WASM RPC request');
    const errorResponse: JsonRpcResponse = {
      jsonrpc: '2.0' as const,
      id: null,
      error: {
        code: -32000,
        message: 'Server error',
        data: (error as Error).message,
      },
    };
    try {
      await fs.writeFile(responsePath, JSON.stringify(errorResponse), 'utf-8');
    } catch {
      // Ignore write errors
    }
  }
}

/**
 * Setup environment for guest WASM to use host RPC bridge
 */
export function setupWasmRpcEnvironment(workDir: string): Record<string, string> {
  return {
    WASM_RPC_WORK_DIR: workDir,
    WASM_RPC_REQUEST_FILE: RPC_REQUEST_FILE,
    WASM_RPC_RESPONSE_FILE: RPC_RESPONSE_FILE,
  };
}

