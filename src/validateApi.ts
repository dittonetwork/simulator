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
      taskDefinitionId,
      performer,
      targetChainId
    } = req.body || {};

    logger.info(`[ValidateAPI] Validation request received: ${JSON.stringify(req.body)}`);
    
    if (!proofOfTask || typeof proofOfTask !== 'string') {
      logger.warn('[ValidateAPI] Invalid request: proofOfTask is required and must be a string');
      return res.status(200).json({ data: false, error: true, message: 'proofOfTask is required and must be a string' });
    }

    // proofOfTask format: "ipfsHash_nextSimulationTime_chainID"
    const [ipfsHash, nextSimulationTimeStr, chainIdStr] = String(proofOfTask).split('_');
    if (!ipfsHash) {
      logger.warn('[ValidateAPI] Invalid proofOfTask: missing ipfsHash');
      return res.status(200).json({ data: false, error: true, message: 'Invalid proofOfTask: missing ipfsHash' });
    }
    if (nextSimulationTimeStr === undefined) {
      logger.warn('[ValidateAPI] Invalid proofOfTask: missing nextSimulationTime');
      return res.status(200).json({ data: false, error: true, message: 'Invalid proofOfTask: missing nextSimulationTime' });
    }
    const nextSimulationTime = Number(nextSimulationTimeStr);
    if (!Number.isInteger(nextSimulationTime) || nextSimulationTime < 0) {
      logger.warn('[ValidateAPI] Invalid proofOfTask: nextSimulationTime must be a non-negative integer');
      return res.status(200).json({ data: false, error: true, message: 'Invalid proofOfTask: nextSimulationTime must be a non-negative integer' });
    }
    if (chainIdStr === undefined) {
      logger.warn('[ValidateAPI] Invalid proofOfTask: missing chainID');
      return res.status(200).json({ data: false, error: true, message: 'Invalid proofOfTask: missing chainID' });
    }
    const chainIdFromProof = Number(chainIdStr);
    if (!Number.isInteger(chainIdFromProof)) {
      logger.warn(`[ValidateAPI] Invalid proofOfTask: chainID must be a uint16 (got ${chainIdStr})`);
      return res.status(200).json({ data: false, error: true, message: 'Invalid proofOfTask: chainID must be a uint16' });
    }

    const nextSimulationTimeIso = new Date(nextSimulationTime * 1000).toISOString();
    logger.info(
      `[ValidateAPI] Validation request for ipfsHash=${ipfsHash} nextSimulationTime=${nextSimulationTime} (${nextSimulationTimeIso}) chainID=${chainIdFromProof}`
    );
    
    if (data === undefined || typeof data !== 'string' || data.length === 0) {
      logger.warn('[ValidateAPI] Invalid request: data is required and must be a non-empty string');
      return res.status(200).json({ data: false, error: true, message: 'data is required and must be a non-empty string' });
    }
    if (taskDefinitionId === undefined) {
      logger.warn('[ValidateAPI] Invalid request: taskDefinitionId is required');
      return res.status(200).json({ data: false, error: true, message: 'taskDefinitionId is required' });
    }
    {
      const n = Number(taskDefinitionId);
      if (!Number.isInteger(n)) {
        logger.warn(`[ValidateAPI] Invalid request: taskDefinitionId must be a uint16 (got ${taskDefinitionId})`);
        return res.status(200).json({ data: false, error: true, message: 'taskDefinitionId must be a uint16' });
      }
    }
    if (performer === undefined) {
      logger.warn('[ValidateAPI] Invalid request: performer is required');
      return res.status(200).json({ data: false, error: true, message: 'performer is required' });
    }
    {
      const isAddr = typeof performer === 'string' && /^0x[a-fA-F0-9]{40}$/.test(performer);
      if (!isAddr) {
        logger.warn(`[ValidateAPI] Invalid request: performer must be a valid address (got ${String(performer)})`);
        return res.status(200).json({ data: false, error: true, message: 'performer must be a valid address' });
      }
    }
    let targetChainIdNum: number;
    if (targetChainId === undefined || targetChainId === null || targetChainId === '') {
      targetChainIdNum = chainIdFromProof;
      logger.info(`[ValidateAPI] targetChainId not provided, using chainIdFromProof=${chainIdFromProof}`);
    } else {
      const n = Number(targetChainId);
      if (!Number.isInteger(n)) {
        logger.warn(`[ValidateAPI] Invalid request: targetChainId must be a uint16 (got ${targetChainId})`);
        return res.status(200).json({ data: false, error: true, message: 'targetChainId must be a uint16' });
      }
      targetChainIdNum = n;
    }

    // TODO check performer in leader election function

    const sdk = getWorkflowSDKService();
    // Ensure we have an access token and pass it through
    await reportingClient.initialize();
    const accessToken = reportingClient.getAccessToken();
    const workflowData = await sdk.loadWorkflowData(ipfsHash);
    const simulationResult = await sdk.simulateWorkflow(
      workflowData,
      ipfsHash,
      isProd,
      ipfsServiceUrl,
      accessToken || undefined,
    );

    let approved = !!simulationResult?.success;
    if (!approved) {
        logger.info(`[ValidateAPI] Simulation failed for ipfsHash=${ipfsHash}`);
        return res.status(200).json({ data: false, error: false, message: 'Simulation failed' });
    }

    const chainResults = (simulationResult.results || []).filter(result => result.chainId === targetChainIdNum);
    if (chainResults.length === 0) {
      logger.info(`[ValidateAPI] No simulation results for targetChainId=${targetChainIdNum} ipfsHash=${ipfsHash}`);
      return res.status(200).json({ data: false, error: false, message: 'No simulation results for targetChainId' });
    }
    approved = chainResults.some(
      result => (result as any)?.userOp?.callData?.toString() === data
    );

    logger.info(`[ValidateAPI] Validation ${approved ? 'APPROVED' : 'REJECTED'} for ipfsHash=${ipfsHash} targetChainId=${targetChainIdNum}`);
    return res.status(200).json({ data: approved, error: false, message: null });
  } catch (err) {
    const error = err as Error;
    logger.error({ error }, '[ValidateAPI] Validation failed');
    return res.status(500).json({ data: null, error: true, message: error.message });
  }
});

export default router;
