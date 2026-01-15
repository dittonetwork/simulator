import http from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import express from "express";

type RunRequest = {
  jobId: string;
  wasmHash?: string;            // hex sha256 (optional, but better to send)
  wasmB64: string;              // bytes wasm in base64
  input: unknown;               // JSON, will go to stdin
  timeoutMs: number;            // n ms
  maxStdoutBytes?: number;      // default 256KB
  maxStderrBytes?: number;      // default 256KB
  maxWasmBytes?: number;        // default 10MB (can be overridden in request, but usually fixed on server)
};

type RunResponse =
  | { jobId: string; ok: true; result: unknown; stderr: string; durationMs: number }
  | { jobId: string; ok: false; error: string; stderr?: string; durationMs: number };

const PORT = Number(process.env.PORT ?? "8080");
const CACHE_DIR = process.env.WASM_CACHE_DIR ?? "/tmp/wasm-cache";

// Server limits (we don't let clients extend them)
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? String(12 * 1024 * 1024)); // 12MB
const MAX_WASM_BYTES = Number(process.env.MAX_WASM_BYTES ?? String(10 * 1024 * 1024)); // 10MB
const DEFAULT_MAX_STDOUT = Number(process.env.MAX_STDOUT_BYTES ?? String(256 * 1024));
const DEFAULT_MAX_STDERR = Number(process.env.MAX_STDERR_BYTES ?? String(256 * 1024));
const MAX_TIMEOUT_MS = Number(process.env.MAX_TIMEOUT_MS ?? "2000"); // protection: we don't allow 60s

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function isHexSha256(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s);
}

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function atomicWriteFile(finalPath: string, data: Buffer) {
  const dir = path.dirname(finalPath);
  const tmpPath = path.join(dir, `.${path.basename(finalPath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tmpPath, data, { mode: 0o444 });
  await fs.rename(tmpPath, finalPath);
}

async function getOrCreateCachedWasm(wasmBytes: Buffer, expectedHash?: string): Promise<{ hash: string; filePath: string }> {
  const hash = sha256Hex(wasmBytes);

  if (expectedHash && expectedHash.toLowerCase() !== hash) {
    throw new Error(`wasmHash mismatch (expected ${expectedHash}, got ${hash})`);
  }

  // split into subfolders to avoid 1e6 files in one place
  const subdir = path.join(CACHE_DIR, hash.slice(0, 2));
  await fs.mkdir(subdir, { recursive: true });

  const filePath = path.join(subdir, `${hash}.wasm`);

  try {
    await fs.access(filePath);
    return { hash, filePath }; // already exists
  } catch {
    // not exists — create
  }

  await atomicWriteFile(filePath, wasmBytes);
  return { hash, filePath };
}

async function runWasmtimeOnce(params: {
  wasmPath: string;
  input: unknown;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}): Promise<{ ok: true; result: unknown; stderr: string } | { ok: false; error: string; stderr?: string }> {
  // Create a temporary work directory for RPC communication
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasm-rpc-'));
  
  // Set wasmtime cache to /tmp to avoid read-only filesystem issues
  // Invoke the 'run' function exported by the WASM module
  // Pre-open the work directory for WASI file access (required for WASM modules)
  // Using --dir to pre-open the directory (read-write access)
  // Pass environment variables to WASM module using --env flags
  const wasmtimeArgs = [
    "run",
    "--invoke", "run",
    "--dir", workDir, // Pre-open work directory for WASI access
    "--env", `WASM_RPC_WORK_DIR=${workDir}`, // Pass work dir path for reference
    "--env", "WASM_RPC_REQUEST_FILE=wasm_rpc_request.json",
    "--env", "WASM_RPC_RESPONSE_FILE=wasm_rpc_response.json",
    params.wasmPath,
  ];
  
  const child = spawn("wasmtime", wasmtimeArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { 
      ...process.env, 
      XDG_CACHE_HOME: "/tmp",
      HOME: "/tmp",
    },
  });
  
  // Start RPC request processor in background
  // This processes RPC requests from guest WASM modules via file-based protocol
  let rpcProcessor: NodeJS.Timeout | null = null;
  try {
    const { processWasmRpcRequests } = await import('./utils/wasmHostBridge.js');
    rpcProcessor = setInterval(async () => {
      try {
        await processWasmRpcRequests(workDir);
      } catch (error) {
        console.error('RPC processor error:', error);
      }
    }, 50); // Check every 50ms (reduced frequency to avoid overwhelming)
  } catch (error) {
    // If RPC bridge fails to load, continue without it
    // Guest modules won't be able to make RPC calls, but execution continues
  }

  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let killedForOutputLimit = false;

  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.length > params.maxStdoutBytes) {
      killedForOutputLimit = true;
      child.kill("SIGKILL");
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]);
    if (stderr.length > params.maxStderrBytes) {
      killedForOutputLimit = true;
      child.kill("SIGKILL");
    }
  });

  // stdin: 1 JSON line
  child.stdin.write(JSON.stringify(params.input) + "\n");
  child.stdin.end();

  const killedByTimeout = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(true);
    }, params.timeoutMs);

    child.on("exit", () => {
      clearTimeout(t);
      if (rpcProcessor) {
        clearInterval(rpcProcessor);
      }
      resolve(false);
    });
  });

  // Clean up work directory
  if (rpcProcessor) {
    clearInterval(rpcProcessor);
  }
  try {
    await fs.rm(workDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  const stderrStr = stderr.toString("utf8");

  if (killedForOutputLimit) {
    return { ok: false, error: "killed: stdout/stderr size limit exceeded", stderr: stderrStr };
  }
  if (killedByTimeout) {
    return { ok: false, error: `timeout after ${params.timeoutMs}ms`, stderr: stderrStr };
  }
  if (child.exitCode !== 0) {
    return { ok: false, error: `exit code ${child.exitCode}`, stderr: stderrStr };
  }

  const outStr = stdout.toString("utf8").trim();
  if (!outStr) {
    return { ok: false, error: "empty stdout", stderr: stderrStr };
  }

  // take the first non-empty line to avoid breaking from extra \n
  const line = outStr.split("\n").map((x) => x.trim()).find(Boolean);
  if (!line) {
    return { ok: false, error: "no JSON line in stdout", stderr: stderrStr };
  }

  try {
    const parsed = JSON.parse(line);
    return { ok: true, result: parsed, stderr: stderrStr };
  } catch (e) {
    return { ok: false, error: `stdout is not JSON: ${(e as Error).message}`, stderr: stderrStr };
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body too large (>${MAX_BODY_BYTES} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`invalid JSON body: ${(e as Error).message}`));
      }
    });

    req.on("error", (e) => reject(e));
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(data.length));
  res.end(data);
}

async function handleRun(req: http.IncomingMessage, res: http.ServerResponse) {
  const started = Date.now();
  let jobId = "unknown";

  try {
    const body = (await readJsonBody(req)) as RunRequest;
    jobId = body.jobId ?? "unknown";

    if (!body.jobId || typeof body.wasmB64 !== "string" || typeof body.timeoutMs !== "number") {
      const resp: RunResponse = { jobId, ok: false, error: "bad request", durationMs: Date.now() - started };
      return sendJson(res, 400, resp);
    }

    const timeoutMs = Math.min(Math.max(1, body.timeoutMs), MAX_TIMEOUT_MS);
    const maxStdoutBytes = Math.min(body.maxStdoutBytes ?? DEFAULT_MAX_STDOUT, DEFAULT_MAX_STDOUT);
    const maxStderrBytes = Math.min(body.maxStderrBytes ?? DEFAULT_MAX_STDERR, DEFAULT_MAX_STDERR);

    const wasmBytes = Buffer.from(body.wasmB64, "base64");
    if (wasmBytes.length === 0) {
      const resp: RunResponse = { jobId, ok: false, error: "empty wasm bytes", durationMs: Date.now() - started };
      return sendJson(res, 400, resp);
    }
    if (wasmBytes.length > MAX_WASM_BYTES) {
      const resp: RunResponse = { jobId, ok: false, error: `wasm too large (> ${MAX_WASM_BYTES} bytes)`, durationMs: Date.now() - started };
      return sendJson(res, 413, resp);
    }

    const expectedHash = body.wasmHash;
    if (expectedHash && !isHexSha256(expectedHash)) {
      const resp: RunResponse = { jobId, ok: false, error: "wasmHash must be 64 hex chars (sha256)", durationMs: Date.now() - started };
      return sendJson(res, 400, resp);
    }

    await ensureCacheDir();
    const { filePath } = await getOrCreateCachedWasm(wasmBytes, expectedHash);

    const exec = await runWasmtimeOnce({
      wasmPath: filePath,
      input: body.input,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
    });

    const durationMs = Date.now() - started;

    if (!exec.ok) {
      const resp: RunResponse = { jobId, ok: false, error: exec.error, stderr: exec.stderr, durationMs };
      return sendJson(res, 200, resp);
    }

    const resp: RunResponse = { jobId, ok: true, result: exec.result, stderr: exec.stderr, durationMs };
    return sendJson(res, 200, resp);
  } catch (e) {
    const durationMs = Date.now() - started;
    const resp: RunResponse = { jobId, ok: false, error: (e as Error).message, durationMs };
    return sendJson(res, 500, resp);
  }
}

// Express route handlers for integration
export async function wasmHealthHandler(req: express.Request, res: express.Response) {
  sendJson(res, 200, { ok: true });
}

export async function wasmRunHandler(req: express.Request, res: express.Response) {
  const started = Date.now();
  let jobId = "unknown";

  try {
    // Express has already parsed the body, so we can use it directly
    const body = req.body as RunRequest;
    jobId = body.jobId ?? "unknown";

    if (!body.jobId || typeof body.wasmB64 !== "string" || typeof body.timeoutMs !== "number") {
      const resp: RunResponse = { jobId, ok: false, error: "bad request", durationMs: Date.now() - started };
      return res.status(400).json(resp);
    }

    const timeoutMs = Math.min(Math.max(1, body.timeoutMs), MAX_TIMEOUT_MS);
    const maxStdoutBytes = Math.min(body.maxStdoutBytes ?? DEFAULT_MAX_STDOUT, DEFAULT_MAX_STDOUT);
    const maxStderrBytes = Math.min(body.maxStderrBytes ?? DEFAULT_MAX_STDERR, DEFAULT_MAX_STDERR);

    const wasmBytes = Buffer.from(body.wasmB64, "base64");
    if (wasmBytes.length === 0) {
      const resp: RunResponse = { jobId, ok: false, error: "empty wasm bytes", durationMs: Date.now() - started };
      return res.status(400).json(resp);
    }
    if (wasmBytes.length > MAX_WASM_BYTES) {
      const resp: RunResponse = { jobId, ok: false, error: `wasm too large (> ${MAX_WASM_BYTES} bytes)`, durationMs: Date.now() - started };
      return res.status(413).json(resp);
    }

    const expectedHash = body.wasmHash;
    if (expectedHash && !isHexSha256(expectedHash)) {
      const resp: RunResponse = { jobId, ok: false, error: "wasmHash must be 64 hex chars (sha256)", durationMs: Date.now() - started };
      return res.status(400).json(resp);
    }

    await ensureCacheDir();
    const { filePath } = await getOrCreateCachedWasm(wasmBytes, expectedHash);

    const exec = await runWasmtimeOnce({
      wasmPath: filePath,
      input: body.input,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
    });

    const durationMs = Date.now() - started;

    if (!exec.ok) {
      const resp: RunResponse = { jobId, ok: false, error: exec.error, stderr: exec.stderr, durationMs };
      return res.status(200).json(resp);
    }

    const resp: RunResponse = { jobId, ok: true, result: exec.result, stderr: exec.stderr, durationMs };
    return res.status(200).json(resp);
  } catch (e) {
    const durationMs = Date.now() - started;
    const resp: RunResponse = { jobId, ok: false, error: (e as Error).message, durationMs };
    return res.status(500).json(resp);
  }
}

// Standalone server mode (if run directly)
async function main() {
  await ensureCacheDir();

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/run") {
      return void handleRun(req, res);
    }
    sendJson(res, 404, { error: "not found" });
  });

  server.listen(PORT, () => {
    console.log(`sandbox runner listening on :${PORT}`);
  });
}

// Only run standalone if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}