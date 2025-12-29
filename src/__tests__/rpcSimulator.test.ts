/**
 * Tests for RPC Simulator
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getRpcSimulator, type JsonRpcRequest } from '../utils/rpcSimulator.js';

describe('RpcSimulator', () => {
  let simulator: ReturnType<typeof getRpcSimulator>;

  beforeEach(() => {
    simulator = getRpcSimulator();
  });

  describe('Allowed methods', () => {
    it('should execute eth_blockNumber', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_blockNumber',
        params: [],
      };

      const response = await simulator.execute(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      expect(typeof response.result).toBe('string');
      // Should be a hex string starting with 0x
      expect((response.result as string).startsWith('0x')).toBe(true);
    });

    it('should execute eth_chainId', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_chainId',
        params: [],
      };

      const response = await simulator.execute(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(2);
      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      expect(typeof response.result).toBe('string');
      expect((response.result as string).startsWith('0x')).toBe(true);
    });

    it('should execute net_version', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'net_version',
        params: [],
      };

      const response = await simulator.execute(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(3);
      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      expect(typeof response.result).toBe('string');
    });

    it('should execute web3_clientVersion', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 4,
        method: 'web3_clientVersion',
        params: [],
      };

      const response = await simulator.execute(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(4);
      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      expect(response.result).toContain('ditto-simulator');
    });
  });

  describe('Disallowed methods', () => {
    it('should reject eth_sendRawTransaction', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 5,
        method: 'eth_sendRawTransaction',
        params: ['0x...'],
      };

      const response = await simulator.execute(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(5);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601); // Method not found
      expect(response.result).toBeUndefined();
    });

    it('should reject eth_sendTransaction', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 6,
        method: 'eth_sendTransaction',
        params: [{}],
      };

      const response = await simulator.execute(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(6);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.result).toBeUndefined();
    });

    it('should reject eth_sign', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 7,
        method: 'eth_sign',
        params: ['0x...', '0x...'],
      };

      const response = await simulator.execute(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(7);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.result).toBeUndefined();
    });
  });

  describe('Invalid requests', () => {
    it('should reject invalid JSON-RPC version', async () => {
      const request = {
        jsonrpc: '1.0',
        id: 8,
        method: 'eth_blockNumber',
        params: [],
      } as unknown as JsonRpcRequest;

      const response = await simulator.execute(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32600); // Invalid Request
    });

    it('should reject missing method', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 9,
      } as JsonRpcRequest;

      const response = await simulator.execute(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32600); // Invalid Request
    });

    it('should reject unsupported method', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 10,
        method: 'eth_unknownMethod',
        params: [],
      };

      const response = await simulator.execute(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(10);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601); // Method not found
    });
  });

  describe('Response integrity', () => {
    it('should return exact JSON response format', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 11,
        method: 'eth_blockNumber',
        params: [],
      };

      const response = await simulator.execute(request);

      // Verify JSON-RPC 2.0 format
      expect(response).toHaveProperty('jsonrpc');
      expect(response).toHaveProperty('id');
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(11);
      
      // Should have either result or error, not both
      const hasResult = 'result' in response;
      const hasError = 'error' in response;
      expect(hasResult || hasError).toBe(true);
      expect(!hasResult || !hasError).toBe(true);
    });
  });
});

