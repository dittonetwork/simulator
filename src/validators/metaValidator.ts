import { WorkflowDocument, BlockTracking, Trigger } from '../interfaces.js';

export class Workflow implements WorkflowDocument {
  ipfs_hash!: string;

  meta!: WorkflowDocument['meta'] | null;

  runs!: number;

  is_cancelled!: boolean;

  next_simulation_time!: Date | null;

  block_tracking?: BlockTracking;

  constructor(raw: WorkflowDocument) {
    Object.assign(this, raw);
  }

  get owner() {
    const owner = this.meta?.workflow?.owner as any;
    if (!owner) return '';
    return typeof owner === 'string' ? owner : owner.address ?? '';
  }

  get triggers(): Trigger[] {
    return this.meta?.workflow?.triggers || [];
  }

  get jobs(): any[] {
    return (this.meta as any)?.workflow?.jobs || [];
  }

  getIpfsHashShort() {
    const hash = this.ipfs_hash || '';
    if (hash.length <= 8) return hash;
    return `${hash.slice(0, 4)}...${hash.slice(-4)}`;
  }
}
