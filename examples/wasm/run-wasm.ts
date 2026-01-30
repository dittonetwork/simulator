/**
 * Simple client to call the WASM runner endpoint.
 *
 * Usage:
 *   WASM_SERVER_URL=http://localhost:8080/wasm \
 *   bun run examples/wasm/run-wasm.ts --wasm ./examples/wasm/sum.wasm --input '{"a": 42, "b": 13}' --timeout 1500
 * 
 * Examples:
 *   - Sum: bun run examples/wasm/run-wasm.ts --wasm ./examples/wasm/sum.wasm --input '{"a": 42, "b": 13}'
 *   - Hello: bun run examples/wasm/run-wasm.ts --wasm ./examples/wasm/hello.wasm --input '{"msg":"hi"}'
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import axios from 'axios';

type Args = {
  wasmPath: string;
  input?: any;
  timeoutMs: number;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let wasmPath = '';
  let input: any = {};
  let timeoutMs = 2000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--wasm' && argv[i + 1]) {
      wasmPath = argv[++i];
    } else if (arg === '--input' && argv[i + 1]) {
      const raw = argv[++i];
      try {
        input = JSON.parse(raw);
      } catch {
        input = raw;
      }
    } else if (arg === '--timeout' && argv[i + 1]) {
      timeoutMs = Number(argv[++i]) || 2000;
    }
  }

  if (!wasmPath) {
    throw new Error('Provide --wasm <path to wasm>');
  }

  return { wasmPath, input, timeoutMs };
}

async function main() {
  const { wasmPath, input, timeoutMs } = parseArgs();

  const wasmServerUrl = process.env.WASM_SERVER_URL || 'http://localhost:8080/wasm';
  const wasmAbs = path.resolve(wasmPath);
  const wasmBytes = await fs.readFile(wasmAbs);
  const wasmB64 = wasmBytes.toString('base64');

  const payload = {
    jobId: `demo-${Date.now()}`,
    wasmB64,
    timeoutMs,
    input,
  };

  console.log(`Calling WASM server at ${wasmServerUrl}/run ...`);
  console.log('Payload:', {
    jobId: payload.jobId,
    wasmB64: `[${wasmB64.length} bytes base64]`,
    wasmBytes: wasmBytes.length,
    timeoutMs: payload.timeoutMs,
    input: payload.input,
  });
  const resp = await axios.post(`${wasmServerUrl}/run`, payload, {
    headers: { 'content-type': 'application/json' },
  });

  console.log('Response:');
  console.dir(resp.data, { depth: 5 });
}

main().catch((err) => {
  console.error('Failed:', err?.response?.data || err?.message || err);
  process.exit(1);
});

