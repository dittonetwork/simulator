/**
 * Upload WASM module to IPFS (QuickNode) and generate wasmId from keccak256 of name
 *
 * Usage:
 *   bun run upload-wasm.ts <path> <name> [--update]
 *
 * Example:
 *   bun run upload-wasm.ts ./yield-optimizer.wasm vault-automation-v1
 *   bun run upload-wasm.ts ./yield-optimizer.wasm vault-automation-v1 --update
 *
 * Options:
 *   --update  Append timestamp to filename for IPFS (keeps same wasmId)
 *
 * Output:
 *   - ipfsHash: CID of the uploaded WASM module
 *   - wasmId: keccak256(name) for use in workflows
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { keccak256, stringToBytes } from 'viem';

// Load .env from wasm-ipfs directory (has QuickNode credentials)
dotenv.config({ path: '../../tmp/wasm-ipfs/.env' });

const IPFS_API_URL = process.env.IPFS_API_URL || 'https://api.quicknode.com/ipfs/rest/v1/s3/put-object';
const IPFS_AUTH_TOKEN = process.env.IPFS_AUTH_TOKEN;

if (!IPFS_AUTH_TOKEN) {
  console.error('Missing required environment variable: IPFS_AUTH_TOKEN');
  console.error('Please set it in ../../tmp/wasm-ipfs/.env or as environment variable');
  process.exit(1);
}

interface QuickNodeResponse {
  requestid: string;
  status: string;
  created: string;
  pin: {
    cid: string;
    name: string;
    origin: { [key: string]: string };
    meta: { [key: string]: string };
  };
  info: {
    size: string;
  };
  delegates: string[];
}

async function uploadWasmToIpfs(wasmPath: string, fileName: string): Promise<string> {
  const wasmBytes = fs.readFileSync(wasmPath);

  console.log(`Reading WASM bytes from: ${wasmPath}`);
  console.log(`File size: ${(wasmBytes.length / 1024).toFixed(2)} KB`);

  // Create FormData for multipart upload
  const formData = new FormData();
  const blob = new Blob([wasmBytes], { type: 'application/wasm' });
  formData.append('Body', blob, fileName);
  formData.append('Key', fileName);
  formData.append('ContentType', 'application/wasm');

  console.log(`Uploading to QuickNode IPFS as: ${fileName}`);

  const response = await fetch(IPFS_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': IPFS_AUTH_TOKEN!,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`IPFS upload failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const data = await response.json() as QuickNodeResponse;
  console.log(`Upload successful. Request ID: ${data.requestid}`);

  return data.pin.cid;
}

async function main() {
  const args = process.argv.slice(2);
  const isUpdate = args.includes('--update');
  const filteredArgs = args.filter(a => a !== '--update');

  if (filteredArgs.length < 2) {
    console.error('Usage: bun run upload-wasm.ts <path> <name> [--update]');
    console.error('');
    console.error('Arguments:');
    console.error('  path     - Path to the WASM file to upload');
    console.error('  name     - Name for the WASM module (used to generate wasmId via keccak256)');
    console.error('  --update - Append timestamp to filename for IPFS (for re-uploads)');
    console.error('');
    console.error('Example:');
    console.error('  bun run upload-wasm.ts ./yield-optimizer.wasm vault-automation-v1');
    console.error('  bun run upload-wasm.ts ./yield-optimizer.wasm vault-automation-v1 --update');
    process.exit(1);
  }

  const wasmPath = path.resolve(filteredArgs[0]);
  const name = filteredArgs[1];

  console.log('=== WASM Module Upload ===\n');

  // Check if WASM file exists
  if (!fs.existsSync(wasmPath)) {
    console.error(`WASM file not found: ${wasmPath}`);
    process.exit(1);
  }

  // Get file stats
  const stats = fs.statSync(wasmPath);
  console.log(`WASM Path: ${wasmPath}`);
  console.log(`WASM Size: ${(stats.size / 1024).toFixed(2)} KB`);
  console.log(`Name: ${name}`);
  console.log('');

  // Generate wasmId from keccak256 of name (without 0x prefix)
  const wasmId = keccak256(stringToBytes(name)).slice(2);
  console.log(`Generating wasmId from keccak256("${name}")...`);
  console.log(`wasmId: ${wasmId}`);
  console.log('');

  // Determine filename - append timestamp for updates to avoid collision
  const fileName = isUpdate
    ? `${name}-${Date.now()}.wasm`  // e.g., vault-automation-v1-1738000000000.wasm
    : `${name}.wasm`;

  if (isUpdate) {
    console.log('Update mode: appending timestamp to avoid IPFS name collision');
    console.log(`IPFS filename: ${fileName}`);
    console.log('');
  }

  // Upload to IPFS
  try {
    const ipfsHash = await uploadWasmToIpfs(wasmPath, fileName);

    // Print results
    console.log('\n=== Result ===');
    console.log(`ipfsHash: ${ipfsHash}`);
    console.log(`wasmId: ${wasmId}`);

    console.log('\n=== IPFS Gateway URLs ===');
    console.log(`https://ipfs.io/ipfs/${ipfsHash}`);
    console.log(`https://quicknode.quicknode-ipfs.com/ipfs/${ipfsHash}`);

  } catch (error) {
    console.error('\nFailed to upload to IPFS:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
