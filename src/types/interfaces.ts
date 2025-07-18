import { Workflow } from "@ditto/workflow-sdk";

export interface BlockTrackingEntry {
  last_processed_block: number;
  last_updated: Date;
  chainId?: number;
  signature?: string;
  address?: string;
}

export type BlockTracking = Record<string, BlockTrackingEntry>;

export interface MetaShape {
  workflow: Workflow;
  metadata: {
    createdAt: {
      $numberLong: string;
    };
    version: string;
  };
}

export interface WorkflowDocument {
  ipfs_hash: string;
  meta: MetaShape | null;
  runs: number;
  is_cancelled: boolean;
  next_simulation_time: Date | null;
  last_simulation?: unknown;
  block_tracking?: BlockTracking;
  created_at?: Date;
  updated_at?: Date;
} 