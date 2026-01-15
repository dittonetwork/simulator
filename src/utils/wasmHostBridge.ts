/**
 * WASM Host Bridge - Communication protocol for host function calls
 * 
 * Since the Wasmtime JS package has limited API, we use a communication protocol
 * via environment variables and files to enable host.rpc_call functionality.
 * 
 * The guest WASM module can write RPC requests to a file, and the host
 * processes them and writes responses back.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getRpcSimulator, type JsonRpcRequest, type JsonRpcResponse } from './rpcSimulator.js';
import { getLogger } from '../logger.js';

const logger = getLogger('WasmHostBridge');

const RPC_REQUEST_FILE = 'wasm_rpc_request.json';
const RPC_RESPONSE_FILE = 'wasm_rpc_response.json';
const MAX_REQUEST_SIZE = 64 * 1024; // 64KB
const MAX_RESPONSE_SIZE = 1024 * 1024; // 1MB
const RPC_TIMEOUT_MS = 5000; // 5 seconds - network RPC calls need time

/**
 * Process RPC requests from guest WASM module
 * 
 * This function reads RPC requests from a file (written by guest),
 * processes them via the simulator, and writes responses back.
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

    logger.info(`Processing RPC request from ${requestPath}`);
    
    // Get simulator lazily to allow proper initialization
    const simulator = getRpcSimulator();

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

    // Execute with timeout
    const timeoutPromise = new Promise<JsonRpcResponse>((resolve) => {
      setTimeout(() => {
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

    logger.info(`Executing RPC method: ${request.method}`);
    const executePromise = simulator.execute(request);

    const response = await Promise.race([executePromise, timeoutPromise]);
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

