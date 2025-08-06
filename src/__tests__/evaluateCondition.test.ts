import { describe, it, expect, vi } from 'vitest';
import OnchainChecker from '../onchainChecker.js';
import type { Address } from 'viem';
import { OnchainConditionOperator } from '@ditto/workflow-sdk';

interface Scenario {
  name: string;
  operator: OnchainConditionOperator;
  contractReturn: any;
  compareValue: any;
  expectedSuccess: boolean;
}

const TEST_CHAIN_ID = 1;
const DUMMY_TARGET = '0x0000000000000000000000000000000000000001' as Address;

const scenarios: Scenario[] = [
  {
    name: 'EQUAL (true)',
    operator: OnchainConditionOperator.EQUAL,
    contractReturn: 5,
    compareValue: 5,
    expectedSuccess: true,
  },
  {
    name: 'EQUAL (false)',
    operator: OnchainConditionOperator.EQUAL,
    contractReturn: 5,
    compareValue: 7,
    expectedSuccess: false,
  },
  {
    name: 'NOT_EQUAL (true)',
    operator: OnchainConditionOperator.NOT_EQUAL,
    contractReturn: 3,
    compareValue: 5,
    expectedSuccess: true,
  },
  {
    name: 'GREATER_THAN (true)',
    operator: OnchainConditionOperator.GREATER_THAN,
    contractReturn: 10,
    compareValue: 5,
    expectedSuccess: true,
  },
  {
    name: 'LESS_THAN (true)',
    operator: OnchainConditionOperator.LESS_THAN,
    contractReturn: 2,
    compareValue: 5,
    expectedSuccess: true,
  },
  {
    name: 'GREATER_THAN_OR_EQUAL (true equal)',
    operator: OnchainConditionOperator.GREATER_THAN_OR_EQUAL,
    contractReturn: 5,
    compareValue: 5,
    expectedSuccess: true,
  },
  {
    name: 'LESS_THAN_OR_EQUAL (true equal)',
    operator: OnchainConditionOperator.LESS_THAN_OR_EQUAL,
    contractReturn: 5,
    compareValue: 5,
    expectedSuccess: true,
  },
  {
    name: 'ONE_OF (true)',
    operator: OnchainConditionOperator.ONE_OF,
    contractReturn: 'apple',
    compareValue: ['orange', 'apple', 'banana'],
    expectedSuccess: true,
  },
  {
    name: 'ONE_OF (false)',
    operator: OnchainConditionOperator.ONE_OF,
    contractReturn: 'grape',
    compareValue: ['orange', 'apple', 'banana'],
    expectedSuccess: false,
  },
];

describe('OnchainChecker.evaluateCondition via checkOnchainTriggers', () => {
  scenarios.forEach(({ name, operator, contractReturn, compareValue, expectedSuccess }) => {
    it(`returns ${expectedSuccess} for scenario: ${name}`, async () => {
      // Build a minimal workflow object with one onchain trigger
      const workflow: any = {
        triggers: [
          {
            type: 'onchain',
            params: {
              target: DUMMY_TARGET,
              abi: 'getValue() view returns (uint256)',
              args: [],
              value: undefined,
              chainId: TEST_CHAIN_ID,
              onchainCondition: {
                condition: operator,
                value: compareValue,
              },
            },
          },
        ],
      };

      // Create OnchainChecker and inject mock client
      const checker = new OnchainChecker();

      const mockClient = {
        getBlockNumber: vi.fn().mockResolvedValue(100n),
        readContract: vi.fn().mockResolvedValue(contractReturn),
      };

      // Override internal clients map
      (checker as any).clients = new Map([[TEST_CHAIN_ID, mockClient]]);

      const res = await checker.checkOnchainTriggers(workflow);

      expect(res.results).toHaveLength(1);
      expect(res.results[0].success).toBe(expectedSuccess);
    });
  });
});
