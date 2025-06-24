import cronParser from 'cron-parser';

export function parseCronConfig(cfg) {
    if (!cfg.params.schedule) {
        throw new Error('Missing cron schedule');
    }
    const expression = cfg.params.schedule;
    return {
        type: 'cron',
        expression
    };
}

export function getNextSimulationTime(triggers) {
    if (!Array.isArray(triggers) || triggers.length === 0) {
        throw new Error('triggers must be a non-empty array');
    }
    // Only support new format: meta.workflow.triggers
    const cronConfigs = triggers.filter(cfg => cfg.type === 'cron' && cfg.params && cfg.params.schedule)
        .map(cfg => ({ expression: cfg.params.schedule }));
    if (cronConfigs.length === 0) {
        throw new Error('No valid cron trigger found');
    }
    let nextTime = null;
    for (const cfg of cronConfigs) {
        const cronExpr = cfg.expression;
        if (!cronExpr) continue;
        try {
            const now = new Date();
            const interval = cronParser.parseExpression(cronExpr, { currentDate: now });
            const candidateTime = interval.next().toDate();
            if (!nextTime) {
                nextTime = candidateTime;
            }
        } catch (e) {
            console.error('Invalid cron expression', cronExpr, e);
        }
    }
    if (!nextTime) throw new Error('No valid cron trigger found');
    return nextTime;
} 