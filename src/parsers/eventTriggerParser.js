export function parseEventTriggerConfig(cfg) {
    if (!cfg.eventTrigger || !cfg.eventTrigger.signature) {
        throw new Error('Missing eventTrigger signature');
    }
    return {
        type: 'eventTrigger',
        signature: cfg.eventTrigger.signature,
        filter: cfg.eventTrigger.filter || {}
    };
} 