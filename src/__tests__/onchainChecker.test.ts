import { describe, it, expect } from 'vitest';
import OnchainChecker from '../onchainChecker.js';
import type { Address } from 'viem';
import { addressToEmptyAccount } from '@zerodev/sdk';
import { JobBuilder, WorkflowBuilder } from '@ditto/workflow-sdk';
import { sepolia } from 'viem/chains';

// Required env vars:
// - RPC_URL: Sepolia RPC endpoint
// - TEST_CONTRACT_ADDRESS: address of the deployed contract that implements
//   `function check(bool expectedValue) public view returns (bool)`

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
}); 