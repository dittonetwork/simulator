# KernelJS Example Simulator

This project connects to a MongoDB instance, fetches workflows from the `indexer` database, and processes them in a loop every N seconds.

## Setup

1. Copy `.env.example` to `.env` and fill in your values.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the simulator:
   ```bash
   node src/index.js
   ```

## Environment Variables
- `MONGO_URI`: MongoDB connection string
- `DB_NAME`: Database name (default: `indexer`)
- `RUNNER_NODE_SLEEP`: Loop interval in seconds
- `RPC_11155111`: RPC endpoint for chain 11155111

## Workflow
- Fetches non-cancelled workflows with relevant simulation time from the `workflows` collection.
- Processes each workflow (mocked as a log for now).
- Calculates the next simulation time using cron expressions in the workflow config. 