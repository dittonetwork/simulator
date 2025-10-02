# Simulator

A TypeScript-based workflow simulation runner that fetches workflow metadata from IPFS, validates triggers, simulates with Kernel SDK, and (optionally) executes on supported chains.

## Features

- Strict‐mode TypeScript throughout (no implicit `any`)
- Zod-validated runtime configuration via environment variables
- Modular architecture: `db`, `eventMonitor`, `worker`, `parsers`, and SDK integration
- Structured logging via Winston
- ESLint + Prettier code style enforcement
- GitHub Actions CI: install → lint → compile

## Requirements

| Tool | Version |
|------|---------|
| Node | 20.x |
| npm  | 10.x |
| MongoDB | >=6.0 (local or remote) |
| IPFS Gateway | accessible HTTP endpoint |

## Quick Start

```bash
# clone & install
git clone <repo>
cd simulator

npm install
git submodule update --init --recursive
npm run build -w ditto-workflow-sdk

# copy and adjust environment variables
cp .env.example .env

# compile
npm install
npm run build

# run the simulator (dev)
npm run dev
```

## Environment Variables

See `env.example` for the full list. Key values:

```env
MONGO_URI=mongodb://localhost:27017
DB_NAME=indexer
RPC_URL=https://rpc.ankr.com/eth_sepolia
EXECUTOR_PRIVATE_KEY=0x...
EXECUTOR_ADDRESS=0x...
AGGREGATOR_URL=http://localhost:8080
OTHENTIC_FLOW=false
FULL_NODE=false
MAX_WORKERS=4
RUNNER_NODE_SLEEP=60
```

All variables are validated at runtime in `src/config.ts`.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start simulator using `tsx` (ts-node equivalent) |
| `npm run build` | Transpile TypeScript → `dist/` |
| `npm run lint`  | ESLint check (`--max-warnings=0`) |
| `npm run lint:fix` | Auto-fix ESLint issues |
| `npm run format` | Prettier write |
| `npm run test:integration` | Minimal integration smoke test |

## Logging

Logs are emitted to stdout using Winston with timestamp & colorized level. Module-specific child loggers are created via `getLogger('Module')`.

## CI Pipeline

Every push & pull-request triggers the GitHub Actions workflow located at `.github/workflows/ci.yml` which:

1. Checks out the repo
2. Sets up Node 20 with npm cache
3. Installs dependencies via `npm ci`
4. Runs `npm run lint`
5. Runs `npm run build`

## Contributing

1. Fork & branch from `initial-impl`
2. Follow Prettier/Lint rules (`npm run lint:fix`)
3. Submit a PR; CI must pass

## License

MIT © 2025

## 🚀 Quick Setup

### Prerequisites
- Node.js 18+ 
- Git
- Docker (optional)

### Setup

1. **Clone this repository:**
   ```bash
   git clone <simulator-repo-url>
   cd simulator
   ```

2. **Run the setup script:**
   ```bash
   ./setup.sh
   ```
   This will:
   - Clone the WorkflowSDK into `./ditto-workflow-sdk/`
   - Build the SDK
   - Install simulator dependencies
   - Build the simulator

3. **Configure environment:**
   ```bash
   cp env.example .env
   # Edit .env with your configuration
   ```

## 📁 Project Structure

```
simulator/
├── ditto-workflow-sdk/          # SDK cloned here (auto-generated)
├── src/
│   ├── integrations/
│   │   ├── workflowSDK.ts       # TypeScript integration bridge
│   │   └── workflowSDK.js       # JavaScript wrapper
│   ├── index.js                 # Main simulator
│   ├── worker.js                # Workflow processor
│   └── test-integration.js      # Integration tests
├── Dockerfile                   # Production Docker image
├── Dockerfile.test             # Test Docker image
├── setup.sh                    # Setup script
└── package.json
```

## 🧪 Testing

Run integration tests:
```bash
npm run test:integration
```

## 📡 Validate Task API

HTTP server exposes a validation endpoint used to pre-approve workflow executions by simulating them via the Workflow SDK.

- Base URL: `http://localhost:${HTTP_PORT}` (default `8080`)
- Endpoint: `POST /task/validate`

Request body (JSON):

```json
{
  "proofOfTask": "<ipfsHash_nextSimulationTime_chainId>",
  "data": "<encoded callData string>",
  "taskDefinitionID": 123,
  "performer": "0x1234abcd5678ef901234abcd5678ef901234abcd",
  "targetChainId": 11155111
}
```

Constraints:
- `proofOfTask`: required string, format `ipfsHash_nextSimulationTime_chainID`
- `data`: required non-empty string (encoded tuple `(address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)` containing packed user operation data)
- `taskDefinitionID`: uint16 (0…65535)
- `performer`: EVM address (`0x` + 40 hex chars)
- `targetChainId`: uint16 (chain to compare results against)

Response (200):

```json
{ "data": true | false, "error": false, "message": null | string }
```

- `data=true` means the simulation succeeded and the produced callData exactly matches `data` for the specified `targetChainId`.
- On validation errors (bad input) the API returns 200 with `error=true` and a descriptive `message`.
- On unexpected exceptions the API returns 500 with `error=true`.

Example:

```bash
curl -sS -X POST http://localhost:8080/task/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "proofOfTask": "Qm...",
    "data": "0xabcdef...",
    "taskDefinitionID": 1,
    "performer": "0x1234abcd5678ef901234abcd5678ef901234abcd",
    "targetChainId": 11155111
  }'
```

## 🏃 Running

### Local Development
```bash
npm start
```

### Docker
```bash
# Build image
docker build -t simulator .

# Run container
docker run --env-file .env simulator
```

### Docker Compose
```bash
docker-compose up
```

## ⚙️ Configuration

Required environment variables:

```bash
# MongoDB
MONGO_URI=mongodb://localhost:27017
DB_NAME=indexer

# Blockchain
RPC_URL=https://your-rpc-url
EXECUTOR_PRIVATE_KEY=0x...
WORKFLOW_CONTRACT_ADDRESS=0x...
IPFS_SERVICE_URL=https://your-ipfs-service

# Simulator Settings  
RUNNER_NODE_SLEEP=6
MAX_WORKERS=2
FULL_NODE=true
```

Additional variables used by the API and runtime:

```bash
# HTTP server
HTTP_PORT=8080

# When enabled, runs only the HTTP API (no simulator loop)
API_ONLY=true

# ZeroDev & environment for simulation
IPFS_SERVICE_URL=your-zerodev-api-key
IS_PROD=false

# Per-chain RPC (overrides); falls back to SDK chain config
# RPC_URL_<CHAIN_ID>=https://...
```

## 🧩 Othentic Flow

When `OTHENTIC_FLOW=true`, execution switches to an aggregator JSON-RPC call with ECDSA signing of a message hash built as:

- `keccak256(abi.encode(string proofOfTask, bytes data, address performer, uint16 taskDefinitionId))`

The simulator sends to `AGGREGATOR_URL`:

```json
{
  "jsonrpc": "2.0",
  "method": "sendTask",
  "params": [
    "<proofOfTask>",
    "<data>",
    "<taskDefinitionId>",
    "<performerAddress>",
    "<signature>",
    "ecdsa",
    "<targetChainId>"
  ]
}
```

- `proofOfTask`: `ipfsHash_nextSimulationTime_chainID`
- `data`: encoded tuple containing packed user operation data
- `performerAddress`: from `EXECUTOR_ADDRESS`
- `signature`: produced using `EXECUTOR_PRIVATE_KEY`
- `targetChainId`: from simulation result

## 🔄 Updating SDK

To update the WorkflowSDK to the latest version:
```bash
./setup.sh
```

## 🐳 Docker Development

For Docker development with live updates:
```bash
# Build test image
docker build -f Dockerfile.test -t simulator-test .

# Run integration test
docker run --env-file .env simulator-test
```

## 📊 Workflow Processing

The simulator:
1. **Connects to MongoDB** to find workflows ready for execution
2. **Loads workflow data** from IPFS using the WorkflowSDK
3. **Simulates execution** to estimate gas costs
4. **Executes workflows** on-chain using ZeroDev sessions
5. **Updates MongoDB** with execution results and next run times

## 🛡️ Key Features

- ✅ **Real blockchain execution** using ZeroDev Account Abstraction
- ✅ **Data-driven approach** with workflow dictionaries
- ✅ **MongoDB integration** for workflow storage and caching
- ✅ **Docker support** for production deployment
- ✅ **TypeScript integration** with proper type safety
- ✅ **Automatic scheduling** with cron trigger support
- ✅ **Gas estimation** before execution
- ✅ **Error handling** and retry logic

## 🔧 Development

### Building
```bash
npm run build
```

### Watch mode
```bash
npm run build:watch
```

### Local SDK development
If you're developing the SDK locally, the simulator will automatically use your local changes after running `./setup.sh`. 