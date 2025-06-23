export function parseCronConfig(cfg) {
    if (!cfg.expression && !(cfg.params && cfg.params.expression)) {
        throw new Error('Missing cron expression');
    }
    const expression = cfg.expression || (cfg.params && cfg.params.expression);
    return {
        type: 'cron',
        expression
    };
} 