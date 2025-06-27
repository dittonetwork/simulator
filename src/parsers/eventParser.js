export function parseEventConfig(cfg) {
    if (!cfg.params || !cfg.params.signature) {
        throw new Error('Missing event signature');
    }
    return {
        type: 'event',
        signature: cfg.params.signature,
        filter: cfg.params.filter || {},
        chainId: cfg.params.chainId || 11155111, // Default to Sepolia
        address: cfg.params.address || cfg.params.filter?.address
    };
} 