import http from 'node:http';
import { URL } from 'node:url';
import { getLogger } from '../logger.js';

const logger = getLogger('WasmClient');

export interface WasmRunRequest {
  jobId: string;
  wasmHash?: string;            // hex sha256 (optional, but better to send)
  wasmB64: string;              // bytes wasm in base64
  input: unknown;               // JSON, will go to stdin
  timeoutMs: number;            // n ms
  maxStdoutBytes?: number;      // default 256KB
  maxStderrBytes?: number;      // default 256KB
}

export interface WasmRunResponse {
  jobId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  stderr?: string;
  durationMs: number;
}

/**
 * Client for calling WASM execution server
 */
export class WasmClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    // Ensure URL doesn't end with /
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Execute WASM code on the server
   */
  async run(request: WasmRunRequest): Promise<WasmRunResponse> {
    const url = `${this.baseUrl}/run`;
    
    // Parse URL to ensure proper formatting
    let urlObj: URL;
    try {
      urlObj = new URL(url);
    } catch (error) {
      logger.error({ error, url }, 'Invalid WASM server URL');
      throw new Error(`Invalid WASM server URL: ${url}`);
    }
    
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(request);
      const port = urlObj.port ? parseInt(urlObj.port, 10) : (urlObj.protocol === 'https:' ? 443 : 80);
      const options = {
        hostname: urlObj.hostname,
        port: port,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      
      logger.debug({ url, hostname: options.hostname, port: options.port, path: options.path }, 'Making WASM request');

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          // Check if response is successful
          if (res.statusCode && res.statusCode >= 400) {
            const errorPreview = data.substring(0, 200);
            logger.error({ 
              statusCode: res.statusCode, 
              statusMessage: res.statusMessage,
              url,
              responsePreview: errorPreview 
            }, 'WASM server returned error status');
            reject(new Error(`WASM server error ${res.statusCode}: ${res.statusMessage}. Response: ${errorPreview}`));
            return;
          }

          // Check if response is HTML (error page)
          if (data.trim().startsWith('<!DOCTYPE') || data.trim().startsWith('<html')) {
            logger.error({ url, responsePreview: data.substring(0, 500) }, 'WASM server returned HTML instead of JSON');
            reject(new Error(`WASM server returned HTML (likely 404 or error page). Check that endpoint ${url} exists. Response preview: ${data.substring(0, 200)}`));
            return;
          }

          try {
            const response = JSON.parse(data) as WasmRunResponse;
            resolve(response);
          } catch (error) {
            logger.error({ error, data: data.substring(0, 500), url, statusCode: res.statusCode }, 'Failed to parse WASM server response');
            reject(new Error(`Invalid JSON response from WASM server: ${(error as Error).message}. Response preview: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', (error) => {
        logger.error({ error, url }, 'Failed to connect to WASM server');
        reject(new Error(`WASM server connection failed: ${error.message}`));
      });

      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('WASM server request timeout'));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Check if WASM server is healthy
   */
  async healthCheck(): Promise<boolean> {
    const url = `${this.baseUrl}/health`;
    
    return new Promise((resolve) => {
      const req = http.get(url, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.ok === true);
          } catch {
            resolve(false);
          }
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }
}

/**
 * Create a WASM client from environment or use integrated server
 * 
 * If WASM_SERVER_URL is set, uses external server.
 * Otherwise, uses integrated server at /wasm/* endpoints on the same host.
 */
export function createWasmClient(baseUrlOverride?: string): WasmClient | null {
  const wasmServerUrl = process.env.WASM_SERVER_URL || baseUrlOverride;
  
  if (wasmServerUrl) {
    // Use external WASM server or override
    return new WasmClient(wasmServerUrl);
  }
  
  // Use integrated WASM server (same host, /wasm prefix)
  // Note: This assumes the client is calling from the same server
  // For remote operators, set WASM_SERVER_URL to the full URL
  const httpPort = process.env.HTTP_PORT || '8080';
  const host = process.env.HOST || 'localhost';
  const baseUrl = `http://${host}:${httpPort}/wasm`;
  logger.info(`Using integrated WASM server at ${baseUrl}`);
  return new WasmClient(baseUrl);
}

