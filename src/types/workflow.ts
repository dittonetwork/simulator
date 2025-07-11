import type { Workflow as SDKWorkflow } from "@ditto/workflow-sdk/";

export interface Workflow extends SDKWorkflow {
  ipfs_hash: string;
  meta?: any;
  block_tracking?: Record<string, any>;
  getIpfsHashShort: () => string;
} 