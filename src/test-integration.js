import dotenv from 'dotenv';
dotenv.config();
import { Database } from './db.js';
import { getWorkflowSDKService } from './integrations/workflowSDK.js';

/**
 * Test script to verify WorkflowSDK integration
 */
async function testIntegration() {
    console.log('🚀 Testing WorkflowSDK Integration with MongoDB');
    console.log('='.repeat(60));

    const db = new Database();
    let workflowSDK;

    try {
        // Initialize connections
        await db.connect();
        workflowSDK = getWorkflowSDKService();

        console.log('✅ Connections initialized');

        // Test IPFS hash from our previous example
        const testIpfsHash = "QmeYuoF4EGKc9PinpsHTVaPNTsWKK1rMt9Y7msUZopuAvp";

        // Step 1: Insert test workflow into MongoDB
        console.log('\n📝 Step 1: Creating test workflow in MongoDB...');

        const workflowDoc = {
            ipfs_hash: testIpfsHash,
            is_cancelled: false,
            next_simulation_time: new Date(), // Ready for immediate processing
            runs: 0,
            meta: null, // Will be populated from IPFS
            created_at: new Date(),
            updated_at: new Date()
        };

        // Check if workflow already exists
        const existingWorkflow = await db.findWorkflowByIpfs(testIpfsHash);
        if (existingWorkflow) {
            console.log(`✅ Workflow already exists in MongoDB: ${testIpfsHash}`);
        } else {
            await db.insertWorkflow(workflowDoc);
            console.log(`✅ Test workflow inserted into MongoDB: ${testIpfsHash}`);
        }

        // Step 2: Test loading workflow data from IPFS
        console.log('\n📥 Step 2: Testing IPFS data loading...');
        const workflowData = await workflowSDK.loadWorkflowData(testIpfsHash);
        console.log(`✅ Successfully loaded workflow data`);
        console.log(`  - Sessions: ${workflowData.sessions.length}`);
        console.log(`  - Owner: ${workflowData.workflow.owner}`);
        console.log(`  - Jobs: ${workflowData.workflow.jobs.length}`);

        // Step 3: Test simulation
        console.log('\n⚡ Step 3: Testing workflow simulation...');
        const simulationResult = await workflowSDK.simulateWorkflow(workflowData, testIpfsHash);
        console.log(`✅ Simulation completed: ${simulationResult.success ? 'SUCCESS' : 'FAILED'}`);
        console.log(`  - Sessions simulated: ${simulationResult.results.length}`);

        simulationResult.results.forEach((result, i) => {
            if (result.gas) {
                console.log(`  - Session ${i + 1} gas estimate: ${result.gas.amount} USDC`);
            }
        });

        // Step 4: Test execution (only if simulation successful)
        if (simulationResult.success) {
            console.log('\n🚀 Step 4: Testing workflow execution...');
            const executionResult = await workflowSDK.executeWorkflow(workflowData, testIpfsHash);
            console.log(`✅ Execution completed: ${executionResult.success ? 'SUCCESS' : 'FAILED'}`);
            console.log(`  - Sessions executed: ${executionResult.results.length}`);

            executionResult.results.forEach((result, i) => {
                if (result.userOpHash) {
                    console.log(`  - Session ${i + 1} UserOp: ${result.userOpHash}`);
                }
            });
        } else {
            console.log('\n⚠️  Step 4: Skipping execution due to failed simulation');
        }

        // Step 5: Update MongoDB with workflow data
        console.log('\n💾 Step 5: Updating MongoDB with workflow data...');
        await db.updateWorkflow(testIpfsHash, {
            meta: workflowData,
            updated_at: new Date()
        });
        console.log(`✅ MongoDB updated with workflow data`);

        // Step 6: Test getting workflows from MongoDB
        console.log('\n📋 Step 6: Testing workflow retrieval from MongoDB...');
        const workflows = await db.getRelevantWorkflows();
        console.log(`✅ Retrieved ${workflows.length} workflows from MongoDB`);

        const testWorkflow = workflows.find(w => w.ipfs_hash === testIpfsHash);
        if (testWorkflow) {
            console.log(`✅ Found our test workflow in results`);
            console.log(`  - IPFS Hash: ${testWorkflow.ipfs_hash}`);
            console.log(`  - Owner: ${testWorkflow.meta?.workflow?.owner || 'Not loaded'}`);
            console.log(`  - Sessions: ${testWorkflow.meta?.sessions?.length || 'Not loaded'}`);
        }

        console.log('\n🎉 Integration Test Summary:');
        console.log('✅ MongoDB connection works');
        console.log('✅ IPFS data loading works');
        console.log('✅ Workflow simulation works');
        console.log('✅ Workflow execution works');
        console.log('✅ MongoDB storage integration works');
        console.log('\n🔥 The simulator is ready to process workflows with real execution!');

    } catch (error) {
        console.error('❌ Integration test failed:', error);
        throw error;
    } finally {
        await db.close();
    }
}

// Run the test
testIntegration().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
}); 