import { describe, it, expect } from 'vitest';
import OnchainChecker from '../onchainChecker.js';
import type { Address } from 'viem';
import { addressToEmptyAccount } from '@zerodev/sdk';
import { JobBuilder, WorkflowBuilder } from '@ditto/workflow-sdk';
import { sepolia } from 'viem/chains';

const CONTRACT_ADDRESS = "0x8ef6A764475243c2993c94f492C7a4176EB483a9";
const SHOULD_RUN = !!CONTRACT_ADDRESS;

const chainId = 11155111; // Sepolia

function buildWorkflow(expected: boolean) {
  const owner = addressToEmptyAccount('0x0000000000000000000000000000000000000001');

  const wf = WorkflowBuilder.create(owner as any)
    .addOnchainTrigger({
      target: CONTRACT_ADDRESS as any,
      abi: 'checkValue(bool)',
      args: [expected],
      chainId,
    })
    .addJob(
        JobBuilder.create("mint-nft-job-sepolia")
        .setChainId(sepolia.id)
        .addStep({
          target: "0x34bE7f35132E97915633BC1fc020364EA5134863",
          abi: "mint(address)",
          args: [owner.address!],
          value: BigInt(0)
        })
        .addStep({
          target: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
          abi: "latestRoundData()",
          args: [],
          value: BigInt(0)
        })
        .build())
    .build();

  return wf;
}

function buildMultiTriggerWorkflow(expectedValues: boolean[]) {
  const owner = addressToEmptyAccount('0x0000000000000000000000000000000000000001');
  let builder = WorkflowBuilder.create(owner as any);

  expectedValues.forEach(expected => {
    builder = builder.addOnchainTrigger({
      target: CONTRACT_ADDRESS as any,
      abi: 'checkValue(bool)',
      args: [expected],
      chainId,
    });
  });

  const wf = builder
    .addJob(
      JobBuilder.create("test-job")
        .setChainId(sepolia.id)
        .addStep({
          target: "0x34bE7f35132E97915633BC1fc020364EA5134863",
          abi: "mint(address)",
          args: [owner.address!],
          value: BigInt(0)
        })
        .build())
    .build();

  return wf;
}

function buildWorkflowWithoutTriggers() {
  const owner = addressToEmptyAccount('0x0000000000000000000000000000000000000001');
  
  const wf = WorkflowBuilder.create(owner as any)
    .addJob(
      JobBuilder.create("no-trigger-job")
        .setChainId(sepolia.id)
        .addStep({
          target: "0x34bE7f35132E97915633BC1fc020364EA5134863",
          abi: "mint(address)",
          args: [owner.address!],
          value: BigInt(0)
        })
        .build())
    .build();

  return wf;
}

(SHOULD_RUN ? describe : describe.skip)('OnchainChecker (live Sepolia)', () => {
  const checker = new OnchainChecker();

  it('returns TRUE when contract returns true', async () => {
    const wf = await buildWorkflow(true);
    const res = await checker.checkOnchainTriggers(wf);
    console.log('res', res);
    expect(res.allTrue).toBe(true);
    expect(res.results[0].success).toBe(true);
  });

  it('returns FALSE when contract returns false', async () => {
    const wf = await buildWorkflow(false);
    const res = await checker.checkOnchainTriggers(wf);
    expect(res.allTrue).toBe(false);
    expect(res.results[0].success).toBe(false);
  });

  it('handles workflow without triggers', async () => {
    const wf = buildWorkflowWithoutTriggers();
    const res = await checker.checkOnchainTriggers(wf);
    expect(res.allTrue).toBe(true);
    expect(res.results).toHaveLength(0);
  });

  it('handles undefined workflow', async () => {
    const res = await checker.checkOnchainTriggers(undefined);
    expect(res.allTrue).toBe(true);
    expect(res.results).toHaveLength(0);
  });

  it('returns TRUE when all multiple triggers succeed', async () => {
    const wf = buildMultiTriggerWorkflow([true, true, true]);
    const res = await checker.checkOnchainTriggers(wf);
    expect(res.allTrue).toBe(true);
    expect(res.results).toHaveLength(3);
    expect(res.results.every(r => r.success)).toBe(true);
  });

  it('returns FALSE when all multiple triggers fail', async () => {
    const wf = buildMultiTriggerWorkflow([false, false, false]);
    const res = await checker.checkOnchainTriggers(wf);
    expect(res.allTrue).toBe(false);
    expect(res.results).toHaveLength(3);
    expect(res.results.every(r => !r.success)).toBe(true);
  });

  it('returns FALSE when some triggers succeed and some fail', async () => {
    const wf = buildMultiTriggerWorkflow([true, false, true]);
    const res = await checker.checkOnchainTriggers(wf);
    expect(res.allTrue).toBe(false);
    expect(res.results).toHaveLength(3);
    expect(res.results[0].success).toBe(true);
    expect(res.results[1].success).toBe(false);
    expect(res.results[2].success).toBe(true);
  });

  it('returns FALSE when only first trigger fails', async () => {
    const wf = buildMultiTriggerWorkflow([false, true, true]);
    const res = await checker.checkOnchainTriggers(wf);
    expect(res.allTrue).toBe(false);
    expect(res.results).toHaveLength(3);
    expect(res.results[0].success).toBe(false);
    expect(res.results[1].success).toBe(true);
    expect(res.results[2].success).toBe(true);
  });

  it('returns FALSE when only last trigger fails', async () => {
    const wf = buildMultiTriggerWorkflow([true, true, false]);
    const res = await checker.checkOnchainTriggers(wf);
    expect(res.allTrue).toBe(false);
    expect(res.results).toHaveLength(3);
    expect(res.results[0].success).toBe(true);
    expect(res.results[1].success).toBe(true);
    expect(res.results[2].success).toBe(false);
  });

  it('handles single trigger workflow', async () => {
    const wf = buildMultiTriggerWorkflow([true]);
    const res = await checker.checkOnchainTriggers(wf);
    expect(res.allTrue).toBe(true);
    expect(res.results).toHaveLength(1);
    expect(res.results[0].success).toBe(true);
  });

  it('includes correct metadata in results', async () => {
    const wf = buildMultiTriggerWorkflow([true, false]);
    const res = await checker.checkOnchainTriggers(wf);
    
    expect(res.results).toHaveLength(2);
    
    res.results.forEach((result, index) => {
      expect(result.triggerIndex).toBe(index);
      expect(result.chainId).toBe(chainId);
      expect(typeof result.blockNumber).toBe('number');
      expect(result.blockNumber).toBeGreaterThan(0);
      
      if (result.success) {
        expect(result.result).toBe(true);
        expect(result.error).toBeUndefined();
      } else {
        expect(result.result).toBe(false);
        expect(result.error).toBeUndefined();
      }
    });
  });
}); 