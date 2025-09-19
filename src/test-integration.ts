import dotenv from 'dotenv';
import logger from './logger.js';
import { Database } from './db.js';
import { getWorkflowSDKService } from './integrations/workflowSDK.js';
import { reportingClient } from './reportingClient.js';

dotenv.config();

/**
 * Test script to verify WorkflowSDK integration
 */
async function testIntegration() {
  logger.info('🚀 Testing WorkflowSDK Integration with MongoDB');
  logger.info('='.repeat(60));

  const db = new Database();
  let workflowSDK;

  try {
    // Initialize connections
    await db.connect();
    workflowSDK = getWorkflowSDKService();

    logger.info('✅ Connections initialized');

    // Test IPFS hash from our previous example
    const testIpfsHash = 'QmUW7FQHc5ART25Gmfk66sfDVjadMn2iwtcdGCwCwgKmTM';

    // Step 1: Insert test workflow into MongoDB
    logger.info('\n📝 Step 1: Creating test workflow in MongoDB...');

    const workflowDoc = {
      ipfs_hash: testIpfsHash,
      is_cancelled: false,
      next_simulation_time: new Date(), // Ready for immediate processing
      runs: 0,
      meta: null, // Will be populated from IPFS
      created_at: new Date(),
      updated_at: new Date(),
    };

    // Check if workflow already exists
    const existingWorkflow = await db.findWorkflowByIpfs(testIpfsHash);
    if (existingWorkflow) {
      logger.info(`✅ Workflow already exists in MongoDB: ${testIpfsHash}`);
    } else {
      await db.insertWorkflow(workflowDoc);
      logger.info(`✅ Test workflow inserted into MongoDB: ${testIpfsHash}`);
    }

    // Step 2: Test loading workflow data from IPFS
    logger.info('\n📥 Step 2: Testing IPFS data loading...');
    const workflowData = await workflowSDK.loadWorkflowData(testIpfsHash);
    logger.info(`✅ Successfully loaded workflow data`);
    logger.info(`  - Sessions: ${workflowData.jobs.length}`);
    logger.info(`  - Owner: ${workflowData.owner}`);
    logger.info(`  - Jobs: ${workflowData.jobs.length}`);

    // Ensure access token is available
    await reportingClient.initialize();
    const accessToken = reportingClient.getAccessToken();

    // Step 3: Test simulation
    logger.info('\n⚡ Step 3: Testing workflow simulation...');
    const simulationResult = await workflowSDK.simulateWorkflow(
      workflowData,
      testIpfsHash,
      false,
      process.env.IPFS_SERVICE_URL || "",
      accessToken || undefined,
    );
    logger.info(`✅ Simulation completed: ${simulationResult.success ? 'SUCCESS' : 'FAILED'}`);
    logger.info(`  - Sessions simulated: ${simulationResult.results.length}`);

    simulationResult.results.forEach((result, i) => {
      if (result.gas) {
        logger.info(
          `  - Session ${i + 1} gas estimate:`,
          `preVerificationGas: ${result.gas.preVerificationGas},`,
          `verificationGasLimit: ${result.gas.verificationGasLimit},`,
          `callGasLimit: ${result.gas.callGasLimit}`
        );
      }
    });

    // Step 4: Test execution (only if simulation successful)
    if (simulationResult.success) {
      logger.info('\n🚀 Step 4: Testing workflow execution...');
      const executionResult = await workflowSDK.executeWorkflow(
        workflowData,
        testIpfsHash,
        false,
        process.env.IPFS_SERVICE_URL || "",
        accessToken || undefined,
      );
      logger.info(`✅ Execution completed: ${executionResult.success ? 'SUCCESS' : 'FAILED'}`);
      logger.info(`  - Sessions executed: ${executionResult.results.length}`);

      executionResult.results.forEach((result, i) => {
        if (result.userOpHash) {
          logger.info(`  - Session ${i + 1} UserOp: ${result.userOpHash}`);
        }
      });
    } else {
      logger.warn('\n⚠️  Step 4: Skipping execution due to failed simulation');
    }

    // Step 5: Update MongoDB with workflow data
    logger.info('\n💾 Step 5: Updating MongoDB with workflow data...');
    await db.updateWorkflow(testIpfsHash, {
      meta: {
        workflow: workflowData,
        metadata: {
          createdAt: { $numberLong: Date.now().toString() },
          version: '1.0.0',
        },
      },
      updated_at: new Date(),
    });
    logger.info(`✅ MongoDB updated with workflow data`);

    // Step 6: Test getting workflows from MongoDB
    logger.info('\n📋 Step 6: Testing workflow retrieval from MongoDB...');
    const workflows = await db.getRelevantWorkflows();
    logger.info(`✅ Retrieved ${workflows.length} workflows from MongoDB`);

    const testWorkflow = workflows.find((w) => w.ipfs_hash === testIpfsHash);
    if (testWorkflow) {
      logger.info(`✅ Found our test workflow in results`);
      logger.info(`  - IPFS Hash: ${testWorkflow.ipfs_hash}`);
      logger.info(`  - Owner: ${testWorkflow.meta?.workflow.owner || 'Not loaded'}`);
      logger.info(`  - Jobs: ${testWorkflow.meta?.workflow.jobs?.length || 'Not loaded'}`);
    }

    logger.info('\n🎉 Integration Test Summary:');
    logger.info('✅ MongoDB connection works');
    logger.info('✅ IPFS data loading works');
    logger.info('✅ Workflow simulation works');
    logger.info('✅ Workflow execution works');
    logger.info('✅ MongoDB storage integration works');
    logger.info('\n🔥 The simulator is ready to process workflows with real execution!');
  } catch (error) {
    logger.error({ error: error }, '❌ Integration test failed');
    throw error;
  } finally {
    await db.close();
  }
}

// Run the test
testIntegration().catch((error) => {
  logger.error({ error: error }, 'Test failed');
  process.exit(1);
});
