import cronParser from 'cron-parser';
import { TRIGGER_TYPE } from '../constants.js';
import { getLogger } from '../logger.js';
import type { Trigger } from '@ditto/workflow-sdk';
import { Workflow } from '../types/workflow.js';

const logger = getLogger('CronParser');

interface CronCfg {
  params: { schedule: string };
}

export function parseCronConfig(cfg: CronCfg) {
  if (!(cfg as any).params?.schedule) {
    throw new Error('Missing cron schedule');
  }
  const expression = (cfg as any).params.schedule as string;

  try {
    cronParser.parseExpression(expression, { currentDate: new Date() });
  } catch (e) {
    throw new Error(`Invalid cron schedule: ${expression}`);
  }

  return {
    type: TRIGGER_TYPE.CRON,
    expression,
  };
}

export function getNextSimulationTime(workflow: Workflow): Date | null {
  const triggers = workflow.triggers;
  const validAfter = workflow.meta?.workflow?.validAfter;

  if (!triggers || triggers.length === 0) {
          if (validAfter) {
        return new Date((validAfter as any as number) * 1000);
      }
    return null;
  }

  const cronConfigs = triggers
    .filter((cfg) => cfg.type === TRIGGER_TYPE.CRON && (cfg.params as any)?.schedule)
    .map((cfg) => ({ expression: (cfg.params as any).schedule as string }));

  if (cronConfigs.length === 0) {
    return new Date();
  }

  let nextTime: Date | null = null;
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
      logger.error({ error: err.message || err.toString() }, `Invalid cron expression ${cronExpr}`);
    }
  }

  if (!nextTime) {
    return new Date();
  }
  return nextTime;
}
