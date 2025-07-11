export interface EventConfig {
  signature: string;
  address?: string;
  filter?: Record<string, unknown>;
  chainId?: number;
} 