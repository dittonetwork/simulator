import cronParser from 'cron-parser';

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

export function getNextSimulationTime(simConfigs) {
    if (!Array.isArray(simConfigs) || simConfigs.length === 0) {
        throw new Error('simulationConfig must be a non-empty array');
    }
    let nextTime = null;
    for (const cfg of simConfigs) {
        // Only handle cron configs
        if (cfg.type === 'cron' || cfg.expression || (cfg.params && cfg.params.expression)) {
            let cronExpr = cfg.expression || (cfg.params && cfg.params.expression);
            if (!cronExpr) continue;
            try {
                const now = new Date();
                const interval = cronParser.parseExpression(cronExpr, { currentDate: now });
                const candidateTime = interval.next().toDate();
                if (!nextTime) {
                    nextTime = candidateTime;
                } else {
                    // Optionally warn about multiple crons
                }
            } catch (e) {
                console.error('Invalid cron expression', cronExpr, e);
            }
        }
    }
    if (!nextTime) throw new Error('No valid cron config found');
    return nextTime;
} 