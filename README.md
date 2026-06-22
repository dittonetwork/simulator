# Ditto Simulator

Workflow execution engine for Ditto Network. Fetches workflows from IPFS, simulates via Kernel SDK, and executes on-chain.

## Documentation

| Module | Description |
|--------|-------------|
| [WASM Modules](./wasm_modules/README.md) | Custom WebAssembly modules for workflow automation |
| [Yield Optimizer](./wasm_modules/rebalance-wasm/README.md) | WASM module for DeFi vault yield optimization |

## Setup

```bash
git clone <repo>
cd simulator

npm install
git submodule update --init --recursive
npm run build -w ditto-workflow-sdk

cp .env.example .env
# Edit .env with your configuration

npm run build
npm run dev
```

## Environment Variables

```env
# MongoDB
MONGO_URI=mongodb://localhost:27017
DB_NAME=indexer

# Blockchain
RPC_URL=https://rpc.ankr.com/eth
EXECUTOR_PRIVATE_KEY=0x...
EXECUTOR_ADDRESS=0x...

# Services
IPFS_SERVICE_URL=https://...
AGGREGATOR_URL=http://localhost:8080

# Runtime
MAX_WORKERS=4
RUNNER_NODE_SLEEP=60
FULL_NODE=false
OTHENTIC_FLOW=false

# API mode (runs only HTTP server, no simulator loop)
API_ONLY=false
HTTP_PORT=8080
```

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start simulator (dev mode) |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled simulator |
| `npm run test:integration` | Integration tests |

## Validate Task API

`POST /task/validate`

```json
{
  "proofOfTask": "<ipfsHash_nextSimulationTime_chainId>",
  "data": "<encoded callData>",
  "taskDefinitionID": 123,
  "performer": "0x...",
  "targetChainId": 1
}
```

Response:
```json
{ "data": true, "error": false, "message": null }
```

## Othentic Flow

When `OTHENTIC_FLOW=true`, execution uses aggregator JSON-RPC with ECDSA signing:

```json
{
  "jsonrpc": "2.0",
  "method": "sendTask",
  "params": ["<proofOfTask>", "<data>", "<taskDefinitionId>", "<performer>", "<signature>", "ecdsa", "<chainId>"]
}
```

Message hash: `keccak256(abi.encode(proofOfTask, data, performer, taskDefinitionId))`

## Docker

```bash
docker build -t simulator .
docker run --env-file .env simulator
```

## Project Structure

```
simulator/
├── ditto-workflow-sdk/     # SDK submodule
├── wasm_modules/           # WASM modules
│   └── rebalance-wasm/     # Yield optimizer
├── src/
│   ├── index.ts            # Entry point
│   ├── worker.ts           # Workflow processor
│   ├── config.ts           # Environment validation
│   └── integrations/       # SDK bridge
└── dist/                   # Compiled output
```
