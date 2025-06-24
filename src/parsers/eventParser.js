export function parseEventConfig(cfg) {
    if (!cfg.params || !cfg.params.signature) {
        throw new Error('Missing event signature');
    }
    return {
        type: 'event',
        signature: cfg.params.signature,
        filter: cfg.params.filter || {}
    };
} 