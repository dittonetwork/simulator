import { TRIGGER_TYPE } from './constants.js';

export type TriggerType = (typeof TRIGGER_TYPE)[keyof typeof TRIGGER_TYPE];

export interface CronTriggerParams {
  schedule: string;
}

export interface EventTriggerParams {
  signature: string;
  chainId?: number;
  address?: string;
  filter?: Record<string, unknown>;
}

export type TriggerParams = CronTriggerParams | EventTriggerParams;

export interface Trigger {
  type: TriggerType;
  params: TriggerParams;
}

export interface JobStep {
  target: string;
  calldata: string;
  value: string;
}

export interface Job {
  id: string;
  chainId: number;
  steps: JobStep[];
}

export interface WorkflowMeta {
  workflow: {
    owner: string;
    triggers: Trigger[];
    jobs: Job[];
    count?: number;
    expiresAt?: number;
  };
  sessions?: unknown[];
  metadata?: unknown;
}

export interface BlockTrackingEntry {
  last_processed_block: number;
  last_updated: Date;
  chainId?: number;
  signature?: string;
  address?: string;
}

export type BlockTracking = Record<string, BlockTrackingEntry>;

export interface WorkflowDocument {
  ipfs_hash: string;
  meta: WorkflowMeta | null;
  runs: number;
  is_cancelled: boolean;
  next_simulation_time: Date | null;
  last_simulation?: unknown;
  block_tracking?: BlockTracking;
  created_at?: Date;
  updated_at?: Date;
}
