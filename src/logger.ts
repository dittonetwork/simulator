// eslint-disable-next-line @typescript-eslint/no-var-requires
// @ts-ignore
import pinoPackage from 'pino';
const pino: any = (pinoPackage as any).default || pinoPackage;

const isPretty = process.env.LOG_PRETTY === 'true';

const pinoOptions = isPretty
  ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } }
  : {};

const rootLogger = pino({ level: process.env.LOG_LEVEL || 'info', ...pinoOptions });

// pipe console.* to pino for legacy usage
const consoleMap = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' } as const;
Object.entries(consoleMap).forEach(([method, level]) => {
  (console as any)[method as keyof Console] = (...args: unknown[]) => {
    (rootLogger as any)[level](...args);
  };
});

export default rootLogger;
export const getLogger = (moduleName: string) => rootLogger.child({ module: moduleName });
