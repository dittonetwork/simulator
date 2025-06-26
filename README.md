# Ditto Workflow Simulator

A production-ready workflow simulator that integrates with the Ditto WorkflowSDK for real blockchain execution.

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
   cp .env.example .env
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