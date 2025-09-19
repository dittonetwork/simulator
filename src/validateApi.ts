import { Router, Request, Response } from 'express';
import { getLogger } from './logger.js';
import { getWorkflowSDKService } from './integrations/workflowSDK.js';
import { reportingClient } from './reportingClient.js';
import { bigIntToString } from './utils.js';

const logger = getLogger('ValidateAPI');
const router = Router();

const isProd = process.env.IS_PROD === 'true';
const ipfsServiceUrl = process.env.IPFS_SERVICE_URL || '';

router.post('/task/validate', async (req: Request, res: Response) => {
  try {
    const {
      proofOfTask,
      data,
      taskDefinitionID,
      performer,
      targetChainId
    } = req.body || {};

    if (!proofOfTask || typeof proofOfTask !== 'string') {
      return res.status(200).json({ data: false, error: true, message: 'proofOfTask is required and must be a string' });
    }
    if (data === undefined || typeof data !== 'string' || data.length === 0) {
      return res.status(200).json({ data: false, error: true, message: 'data is required and must be a non-empty string' });
    }
    if (taskDefinitionID === undefined) {
      return res.status(200).json({ data: false, error: true, message: 'taskDefinitionID is required' });
    }
    {
      const n = Number(taskDefinitionID);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        return res.status(200).json({ data: false, error: true, message: 'taskDefinitionID must be a uint16' });
      }
    }
    if (performer === undefined) {
      return res.status(200).json({ data: false, error: true, message: 'performer is required' });
    }
    {
      const isAddr = typeof performer === 'string' && /^0x[a-fA-F0-9]{40}$/.test(performer);
      if (!isAddr) {
        return res.status(200).json({ data: false, error: true, message: 'performer must be a valid address' });
      }
    }
    if (targetChainId === undefined) {
      return res.status(200).json({ data: false, error: true, message: 'targetChainId is required' });
    }
    {
      const n = Number(targetChainId);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        return res.status(200).json({ data: false, error: true, message: 'targetChainId must be a uint16' });
      }
    }

    // TODO check performer in leader election function

    logger.info(`Validation request for proofOfTask=${proofOfTask}`);

    const sdk = getWorkflowSDKService();
    // Ensure we have an access token and pass it through
    await reportingClient.initialize();
    const accessToken = reportingClient.getAccessToken();
    const workflowData = await sdk.loadWorkflowData(proofOfTask);
    const simulationResult = await sdk.simulateWorkflow(
      workflowData,
      proofOfTask,
      isProd,
      ipfsServiceUrl,
      accessToken || undefined,
    );

    let approved = !!simulationResult?.success;
    if (!approved) {
        return res.status(200).json({ data: false, error: false, message: 'Simulation failed' });
    }

    const chainResults = (simulationResult.results || []).filter(result => result.chainId === Number(targetChainId));
    if (chainResults.length === 0) {
      return res.status(200).json({ data: false, error: false, message: 'No simulation results for targetChainId' });
    }
    approved = chainResults.some(
      result => (result as any)?.userOp?.callData?.toString() === data
    );

    return res.status(200).json({ data: approved, error: false, message: null });
  } catch (err) {
    const error = err as Error;
    logger.error({ error }, 'Validation failed');
    return res.status(500).json({ data: null, error: true, message: error.message });
  }
});

export default router;
