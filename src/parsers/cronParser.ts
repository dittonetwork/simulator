import cronParser from 'cron-parser';
import { TRIGGER_TYPE } from '../constants.js';
import { getLogger } from '../logger.js';
import type { Trigger } from '../interfaces.js';

const logger = getLogger('CronParser');

interface CronCfg {
  params: { schedule: string };
}

export function parseCronConfig(cfg: CronCfg) {
  if (!(cfg as any).params?.schedule) {
    throw new Error('Missing cron schedule');
  }
  const expression = (cfg as any).params.schedule as string;

  // Validate that the cron expression is syntactically correct. This prevents
  // invalid schedules from being stored and causing runtime errors later.
  try {
    // Attempt to parse once; cron-parser will throw on invalid expressions.
    cronParser.parseExpression(expression, { currentDate: new Date() });
  } catch (e) {
    throw new Error(`Invalid cron schedule: ${expression}`);
  }

  return {
    type: TRIGGER_TYPE.CRON,
    expression,
  };
}

export function getNextSimulationTime(triggers: Trigger[]): Date {
  if (!Array.isArray(triggers) || triggers.length === 0) {
    throw new Error('triggers must be a non-empty array');
  }
  // Only support new format: meta.workflow.triggers
  const cronConfigs = triggers
    .filter((cfg) => cfg.type === TRIGGER_TYPE.CRON && (cfg.params as any)?.schedule)
    .map((cfg) => ({ expression: (cfg.params as any).schedule as string }));
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
      if (!nextTime || candidateTime < nextTime) {
        nextTime = candidateTime;
      }
    } catch (e) {
      const err = e as Error;
      logger.error(`Invalid cron expression ${cronExpr}`, { error: err.message || err.toString() });
    }
  }
  if (!nextTime) throw new Error('No valid cron trigger found');
  return nextTime;
}
