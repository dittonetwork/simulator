import { TRIGGER_TYPE, CHAIN_IDS } from '../constants.js';

export function parseEventConfig(cfg: any) {
  if (!cfg.params || !cfg.params.signature) {
    throw new Error('Missing event signature');
  }
  return {
    type: TRIGGER_TYPE.EVENT,
    signature: cfg.params.signature,
    filter: cfg.params.filter || {},
    chainId: cfg.params.chainId || CHAIN_IDS.SEPOLIA,
    address: cfg.params.address || cfg.params.filter?.address,
  };
}
