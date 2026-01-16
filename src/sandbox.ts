/**
 * WASM Sandbox Entry Point
 * 
 * Minimal server that only handles WASM execution.
 * No database, no IPFS, no simulator logic - just WASM + RPC proxy.
 */

import express from 'express';
import bodyParser from 'body-parser';
import { getLogger } from './logger.js';
import { wasmHealthHandler, wasmRunHandler } from './server.js';

const logger = getLogger('WasmSandbox');

const app = express();

// Request logging (skip health checks to reduce noise)
app.use((req, res, next) => {
  if (!req.url.includes('/health')) {
    logger.info({ method: req.method, url: req.url }, 'Request');
  }
  next();
});

// Body parser for WASM payloads
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? String(12 * 1024 * 1024));
app.use(bodyParser.json({ limit: MAX_BODY_BYTES }));

// WASM endpoints
app.get('/wasm/health', wasmHealthHandler);
app.post('/wasm/run', wasmRunHandler);

// Health check at root
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'wasm-sandbox' });
});

const PORT = parseInt(process.env.PORT || process.env.HTTP_PORT || '8081', 10);

app.listen(PORT, () => {
  logger.info(`WASM Sandbox listening on port ${PORT}`);
  logger.info('Endpoints:');
  logger.info('  GET  /health      - Health check');
  logger.info('  GET  /wasm/health - WASM health check');
  logger.info('  POST /wasm/run    - Execute WASM');
  if (process.env.RPC_PROXY_URL) {
    logger.info(`RPC proxy: ${process.env.RPC_PROXY_URL}`);
  } else {
    logger.warn('RPC_PROXY_URL not set - RPC calls will fail');
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  logger.info('Shutting down...');
  process.exit(0);
});
