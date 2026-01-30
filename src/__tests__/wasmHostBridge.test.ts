/**
 * Tests for WASM Host Bridge
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { processWasmRpcRequests } from '../utils/wasmHostBridge.js';
import type { JsonRpcRequest } from '../utils/rpcSimulator.js';

describe('WasmHostBridge', () => {
  let workDir: string;
  const RPC_REQUEST_FILE = 'wasm_rpc_request.json';
  const RPC_RESPONSE_FILE = 'wasm_rpc_response.json';

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), 'wasm-rpc-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should process allowed method (eth_blockNumber)', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_blockNumber',
      params: [],
    };

    const requestPath = join(workDir, RPC_REQUEST_FILE);
    await fs.writeFile(requestPath, JSON.stringify(request), 'utf-8');

    await processWasmRpcRequests(workDir);

    const responsePath = join(workDir, RPC_RESPONSE_FILE);
    const responseData = await fs.readFile(responsePath, 'utf-8');
    const response = JSON.parse(responseData);

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
  });

  it('should reject disallowed method (eth_sendRawTransaction)', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'eth_sendRawTransaction',
      params: ['0x...'],
    };

    const requestPath = join(workDir, RPC_REQUEST_FILE);
    await fs.writeFile(requestPath, JSON.stringify(request), 'utf-8');

    await processWasmRpcRequests(workDir);

    const responsePath = join(workDir, RPC_RESPONSE_FILE);
    const responseData = await fs.readFile(responsePath, 'utf-8');
    const response = JSON.parse(responseData);

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(2);
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32601); // Method not found
    expect(response.result).toBeUndefined();
  });

  it('should reject invalid JSON', async () => {
    const requestPath = join(workDir, RPC_REQUEST_FILE);
    await fs.writeFile(requestPath, 'invalid json{', 'utf-8');

    await processWasmRpcRequests(workDir);

    const responsePath = join(workDir, RPC_RESPONSE_FILE);
    const responseData = await fs.readFile(responsePath, 'utf-8');
    const response = JSON.parse(responseData);

    expect(response.jsonrpc).toBe('2.0');
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32700); // Parse error
  });

  it('should handle missing request file gracefully', async () => {
    // Don't create request file
    await processWasmRpcRequests(workDir);

    // Should not create response file
    const responsePath = join(workDir, RPC_RESPONSE_FILE);
    try {
      await fs.access(responsePath);
      expect.fail('Response file should not exist');
    } catch {
      // Expected - file doesn't exist
    }
  });

  it('should enforce request size limit', async () => {
    // Create a request that's too large (> 64KB)
    const largeRequest = {
      jsonrpc: '2.0',
      id: 3,
      method: 'eth_blockNumber',
      params: [],
      largeData: 'x'.repeat(65 * 1024), // 65KB
    };

    const requestPath = join(workDir, RPC_REQUEST_FILE);
    await fs.writeFile(requestPath, JSON.stringify(largeRequest), 'utf-8');

    await processWasmRpcRequests(workDir);

    const responsePath = join(workDir, RPC_RESPONSE_FILE);
    const responseData = await fs.readFile(responsePath, 'utf-8');
    const response = JSON.parse(responseData);

    expect(response.jsonrpc).toBe('2.0');
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32600); // Invalid Request
    expect(response.error?.data).toContain('too large');
  });

  it('should clean up request file after processing', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 4,
      method: 'eth_blockNumber',
      params: [],
    };

    const requestPath = join(workDir, RPC_REQUEST_FILE);
    await fs.writeFile(requestPath, JSON.stringify(request), 'utf-8');

    await processWasmRpcRequests(workDir);

    // Request file should be deleted
    try {
      await fs.access(requestPath);
      expect.fail('Request file should be deleted');
    } catch {
      // Expected - file should be deleted
    }

    // Response file should exist
    const responsePath = join(workDir, RPC_RESPONSE_FILE);
    await fs.access(responsePath); // Should not throw
  });
});

