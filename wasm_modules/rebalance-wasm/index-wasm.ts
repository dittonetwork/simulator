/**
 * Script to generate MongoDB document for WASM module
 * 
 * This script reads the compiled WASM file, calculates its hash,
 * and prints the MongoDB document that should be inserted.
 * 
 * Usage:
 *   bun run index-wasm.ts > wasm-document.json
 *   # Then insert manually or use mongoimport
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function generateWasmDocument() {
  // Check if WASM file exists
  const wasmPath = path.join(__dirname, 'yield-optimizer.wasm');
  if (!fs.existsSync(wasmPath)) {
    console.error(`❌ WASM file not found: ${wasmPath}`);
    console.error('Please run: ./build.sh first');
    process.exit(1);
  }
  
  // Read WASM file
  const wasmBytes = fs.readFileSync(wasmPath);
  
  // Calculate SHA256 hash
  const wasmHash = crypto.createHash('sha256').update(wasmBytes).digest('hex');
  
  // Create MongoDB document structure matching the new schema
  // Note: In actual MongoDB, 'wasm_code' will be stored as Binary type
  // For JSON output, we'll show it as base64 in $binary format
  const document = {
    wasm_id: wasmHash,
    wasm_code: {
      $binary: {
        base64: wasmBytes.toString('base64'),
        subType: "00"
      }
    },
    wasm_code_size: wasmBytes.length,
    has_wasm: true,
    storedAt: new Date().toISOString(),
  };

  // Print as JSON
  console.log(JSON.stringify(document, null, 2));

  // Also print helpful info to stderr (so it doesn't interfere with JSON output)
  console.error('\n=== WASM Module Document ===');
  console.error(`WASM ID (SHA256): ${wasmHash}`);
  console.error(`Size: ${wasmBytes.length} bytes (${(wasmBytes.length / 1024).toFixed(2)} KB)`);
  console.error('\nMongoDB Insert Command (MongoDB Shell):');
  console.error(`db.wasm_modules.insertOne({`);
  console.error(`  wasm_id: "${document.wasm_id}",`);
  console.error(`  wasm_code: BinData(0, "${wasmBytes.toString('base64')}"),`);
  console.error(`  wasm_code_size: ${document.wasm_code_size},`);
  console.error(`  has_wasm: true,`);
  console.error(`  storedAt: new Date("${document.storedAt}")`);
  console.error(`});`);
  console.error('\nNote: The JSON output above uses $binary format for MongoDB Extended JSON.');
  console.error('In MongoDB shell, use BinData(0, "<base64>") for the wasm_code field.');
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateWasmDocument();
}

export { generateWasmDocument };
