import { TRIGGER_TYPE } from './constants.js';
import * as WF from '../ditto-workflow-sdk/src/core/types.ts';
import * as SDK from '../ditto-workflow-sdk/src/index.ts';

export type CronTriggerParams = WF.CronTriggerParams;
export type EventTriggerParams = WF.EventTriggerParams;
export type Trigger = WF.Trigger;
export type Job = WF.Job;

export type TriggerType = (typeof TRIGGER_TYPE)[keyof typeof TRIGGER_TYPE];

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
  meta: SDK.SerializedWorkflowData | null;
  runs: number;
  is_cancelled: boolean;
  next_simulation_time: Date | null;
  last_simulation?: unknown;
  block_tracking?: BlockTracking;
  created_at?: Date;
  updated_at?: Date;
}
