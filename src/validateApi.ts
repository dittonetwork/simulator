import { Router, Request, Response } from 'express';
import { getLogger } from './logger.js';
import { getWorkflowSDKService } from './integrations/workflowSDK.js';
import { reportingClient } from './reportingClient.js';
import { AbiCoder } from 'ethers';
import { getConfig } from './config.js';
import EventMonitor from './eventMonitor.js';
import { bigIntToString } from './utils.js';
import { createWasmClient, WasmClient } from './utils/wasmClient.js';
import { deserializeDataRefContext, deserializeWasmRefContext } from '@ditto/workflow-sdk';

const logger = getLogger('ValidateAPI');
const router: Router = Router();

const isProd = process.env.IS_PROD === 'true';
const ipfsServiceUrl = process.env.IPFS_SERVICE_URL || '';
const config = getConfig();

// Initialize WASM client if server URL is configured
const wasmClient = config.wasmServerUrl ? createWasmClient() : null;
if (wasmClient) {
  logger.info(`WASM client initialized for server: ${config.wasmServerUrl}`);
  // Health check on startup
  wasmClient.healthCheck().then(healthy => {
    if (healthy) {
      logger.info('WASM server health check passed');
    } else {
      logger.warn('WASM server health check failed - validation may not work');
    }
  }).catch(err => {
    logger.warn({ error: err }, 'WASM server health check error');
  });
} else {
  logger.info('WASM validation disabled (WASM_SERVER_URL not set)');
}

type Hex = `0x${string}`;
type PackedUserOperation = {
  sender: Hex;                     // address
  nonce: bigint;                   // uint256
  initCode: Hex;                   // bytes
  callData: Hex;                   // bytes
  accountGasLimits: Hex;           // bytes32 (verifGas << 128 | callGas)
  preVerificationGas: bigint;      // uint256
  gasFees: Hex;                    // bytes32 (maxPriorityFee << 128 | maxFee)
  paymasterAndData: Hex;           // bytes
  signature: Hex;                  // bytes
};

// Tuple type for packed user operation: (address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)
const tupleType = '(address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)';

/**
 * Parse the encoded tuple data from the validation request
 * @param data - The encoded tuple data as hex string
 * @returns Parsed PackedUserOperation or null if parsing fails
 */
function parseTupleData(data: string): PackedUserOperation | null {
  try {
    if (!data || typeof data !== 'string' || !data.startsWith('0x')) {
      logger.warn('[ValidateAPI] Invalid data format: must be a hex string');
      return null;
    }

    const abiCoder = AbiCoder.defaultAbiCoder();
    const decoded = abiCoder.decode([tupleType], data);
    
    if (!decoded || decoded.length === 0) {
      logger.warn('[ValidateAPI] Failed to decode tuple data');
      return null;
    }

    const tupleData = decoded[0];
    const packedUserOp: PackedUserOperation = {
      sender: tupleData[0] as Hex,
      nonce: tupleData[1] as bigint,
      initCode: tupleData[2] as Hex,
      callData: tupleData[3] as Hex,
      accountGasLimits: tupleData[4] as Hex,
      preVerificationGas: tupleData[5] as bigint,
      gasFees: tupleData[6] as Hex,
      paymasterAndData: tupleData[7] as Hex,
      signature: tupleData[8] as Hex,
    };

    logger.info(`[ValidateAPI] Successfully parsed tuple data: ${JSON.stringify({
      sender: packedUserOp.sender,
      nonce: packedUserOp.nonce.toString(),
      initCode: packedUserOp.initCode,
      callData: packedUserOp.callData,
      accountGasLimits: packedUserOp.accountGasLimits,
      preVerificationGas: packedUserOp.preVerificationGas.toString(),
      gasFees: packedUserOp.gasFees,
      paymasterAndData: packedUserOp.paymasterAndData,
      signature: packedUserOp.signature
    })}`);

    return packedUserOp;
  } catch (error) {
    logger.error({ error }, '[ValidateAPI] Failed to parse tuple data');
    return null;
  }
}

function extractErrorCode(error?: string): string | undefined {
  if (!error) return undefined;
  const line = error
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('Details: '));
  if (!line) return undefined;
  const value = line.slice('Details: '.length).trim();
  return value || undefined;
}

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

    // proofOfTask format: "ipfsHash_nextSimulationTime_chainID[_dataRefHash][_wasmRefHash]"
    // Parse proofOfTask - may include optional context hashes
    const parts = String(proofOfTask).split('_');
    const ipfsHash = parts[0];
    const nextSimulationTimeStr = parts[1];
    const chainIdStr = parts[2];
    // Optional: parts[3] = dataRefHash, parts[4] = wasmRefHash
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

    const nextSimulationTimeIso = new Date(nextSimulationTime).toISOString();
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
    
    // Extract contexts from request body if provided (operator mode - reuse leader's contexts)
    // This ensures operators don't re-execute WASM or use different block numbers
    const dataRefContextSerialized = (req.body as any).dataRefContextSerialized;
    const wasmRefContextSerialized = (req.body as any).wasmRefContextSerialized;
    
    let dataRefContext = undefined;
    let wasmRefContext = undefined;
    
    if (dataRefContextSerialized && typeof dataRefContextSerialized === 'string') {
      try {
        dataRefContext = deserializeDataRefContext(dataRefContextSerialized);
        logger.info(`[ValidateAPI] Using provided dataRefContext (operator mode)`);
      } catch (error) {
        logger.warn({ error }, `[ValidateAPI] Failed to deserialize dataRefContext, will create new context`);
      }
    }
    
    if (wasmRefContextSerialized && typeof wasmRefContextSerialized === 'string') {
      try {
        wasmRefContext = deserializeWasmRefContext(wasmRefContextSerialized);
        logger.info(`[ValidateAPI] Using provided wasmRefContext (operator mode) - ${wasmRefContext.resolvedRefs.length} WASM results`);
      } catch (error) {
        logger.warn({ error }, `[ValidateAPI] Failed to deserialize wasmRefContext, will execute WASM fresh`);
      }
    }
    
    // Operators simulate with leader's contexts to ensure deterministic consensus
    // If contexts provided, operators reuse leader's WASM results and block numbers
    // If not provided, operators execute fresh (fallback for backward compatibility)
    const simulationResult = await sdk.simulateWorkflow(
      workflowData,
      ipfsHash,
      isProd,
      ipfsServiceUrl,
      accessToken || undefined,
      dataRefContext,
      wasmRefContext,
    );

    try {
      const eventMonitor = new EventMonitor();
      try {
        eventMonitor.updateAccessToken(accessToken || undefined);
      } catch {}
      const performerAddrLc = typeof performer === 'string' ? performer.toLowerCase() : '';
      const shouldSkipReport = performerAddrLc !== '' && config.operatorAddress.toLowerCase() === performerAddrLc;
      if (simulationResult && Array.isArray((simulationResult as any).results)) {
        for (const result of (simulationResult as any).results) {
          const chainId = result.chainId;
          let blockNumber: number | undefined = undefined;
          try {
            const bn = await eventMonitor.getCurrentBlockNumber(chainId);
            blockNumber = Number(bn);
          } catch (e) {
            logger.warn(`[ValidateAPI] Failed to fetch current block number for chain ${chainId}: ${String((e as Error)?.message || e)}`);
          }

          const report: any = {
            ipfsHash,
            simulationSuccess: !!simulationResult.success,
            chainsBlockNumbers: blockNumber !== undefined ? { [chainId]: blockNumber } : undefined,
            start: result.start,
            finish: result.finish,
            expected_simulation_start: nextSimulationTimeIso,
            gas_estimate: result.gas?.totalGasEstimate || undefined,
            error_code: extractErrorCode(result.error),
            userOp: bigIntToString(result),
            buildTag: config.buildTag,
            commitHash: config.commitHash,
          };

          try {
            if (shouldSkipReport) {
              logger.info(
                `[ValidateAPI] Skipping report submission for chain ${chainId} because performer equals our address (${performer})`,
              );
            } else {
              await reportingClient.submitReport(bigIntToString(report));
            }
          } catch (error) {
            logger.error({ error }, `[ValidateAPI] Failed to submit simulation report for chain ${chainId}`);
          }
        }
      }
    } catch (e) {
      logger.error({ error: e }, '[ValidateAPI] Unexpected error while reporting simulation results');
    }

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

    // Parse the tuple data from the request
    const packedUserOp = parseTupleData(data);
    if (!packedUserOp) {
      logger.warn(`[ValidateAPI] Failed to parse tuple data for ipfsHash=${ipfsHash}`);
      return res.status(200).json({ data: false, error: true, message: 'Failed to parse tuple data' });
    }

    // Compare the parsed PackedUserOperation with simulation results
    approved = chainResults.some(
      result => {
        const simulationCallData = (result as any)?.userOp?.callData?.toString();
        const simulationNonce = (result as any)?.userOp?.nonce?.toString();
        
        const callDataMatch = simulationCallData === packedUserOp.callData;
        const nonceMatch = simulationNonce === packedUserOp.nonce.toString();
        
        const matches = callDataMatch && nonceMatch;
        
        logger.info(`[ValidateAPI] Validation comparison for chainId=${result.chainId} ${JSON.stringify({
          callDataMatch,
          nonceMatch,
          overallMatch: matches,
          requestPayload: {
            callData: packedUserOp.callData,
            signature: packedUserOp.signature,
            nonce: packedUserOp.nonce.toString()
          },
          simulationPayload: {
            callData: simulationCallData,
            nonce: simulationNonce
          }
        })}`);
        
        return matches;
      }
    );

    // WASM validation (if enabled)
    if (wasmClient && approved) {
      try {
        // Extract WASM code from request if provided, or use default validation logic
        const wasmB64 = (req.body as any).wasmB64;
        const wasmHash = (req.body as any).wasmHash;
        
        if (wasmB64) {
          logger.info(`[ValidateAPI] Running WASM validation for ipfsHash=${ipfsHash}`);
          
          const wasmInput = {
            proofOfTask,
            packedUserOp: {
              sender: packedUserOp.sender,
              nonce: packedUserOp.nonce.toString(),
              callData: packedUserOp.callData,
              signature: packedUserOp.signature,
            },
            simulationResult: chainResults[0],
            targetChainId: targetChainIdNum,
          };

          const wasmResult = await wasmClient.run({
            jobId: `validate-${ipfsHash}-${Date.now()}`,
            wasmHash,
            wasmB64,
            input: wasmInput,
            timeoutMs: 2000, // 2 second timeout for validation
          });

          if (!wasmResult.ok) {
            logger.warn(`[ValidateAPI] WASM validation failed: ${wasmResult.error}`);
            approved = false;
          } else if (wasmResult.result && typeof wasmResult.result === 'object') {
            // WASM should return { approved: boolean, reason?: string }
            const wasmApproved = (wasmResult.result as any).approved === true;
            if (!wasmApproved) {
              logger.info(`[ValidateAPI] WASM validation rejected: ${(wasmResult.result as any).reason || 'no reason provided'}`);
              approved = false;
            } else {
              logger.info(`[ValidateAPI] WASM validation approved`);
            }
          }
        } else {
          logger.debug(`[ValidateAPI] WASM validation skipped (no wasmB64 in request)`);
        }
      } catch (error) {
        logger.error({ error }, `[ValidateAPI] WASM validation error - rejecting for safety`);
        approved = false;
      }
    }

    logger.info(`[ValidateAPI] Validation ${approved ? 'APPROVED' : 'REJECTED'} for ipfsHash=${ipfsHash} targetChainId=${targetChainIdNum}`);
    return res.status(200).json({ data: approved, error: false, message: null });
  } catch (err) {
    const error = err as Error;
    logger.error({ error }, '[ValidateAPI] Validation failed');
    return res.status(500).json({ data: null, error: true, message: error.message });
  }
});

export default router;
