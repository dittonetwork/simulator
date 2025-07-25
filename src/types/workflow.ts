import { WorkflowDocument, BlockTracking, MetaShape } from './interfaces.js';
import { Workflow as WorkflowMeta, Job, Trigger } from '@ditto/workflow-sdk';

export class Workflow implements WorkflowDocument {
  ipfs_hash!: string;

  meta!: MetaShape | null;

  runs!: number;

  is_cancelled!: boolean;

  next_simulation_time!: Date | null;

  block_tracking?: BlockTracking;

  constructor(raw: WorkflowDocument) {
    Object.assign(this, raw);
  }

  get owner() {
    return this.meta?.workflow.owner || '';
  }

  get triggers(): Trigger[] {
    return this.meta?.workflow.triggers || [];
  }

  get jobs(): Job[] {
    return this.meta?.workflow.jobs || [];
  }

  getIpfsHashShort() {
    const hash = this.ipfs_hash || '';
    if (hash.length <= 8) return hash;
    return `${hash.slice(0, 4)}...${hash.slice(-4)}`;
  }
}
