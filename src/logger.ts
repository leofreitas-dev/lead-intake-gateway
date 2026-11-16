import { pino, type Logger } from 'pino';
import type { Config } from './config.ts';

export type { Logger };

/**
 * Structured JSON logs. Every line carries the fields a log tool can filter on;
 * request lines also carry `reqId`, the trace id that follows one lead.
 */
export function createLogger(config: Pick<Config, 'logLevel' | 'logPretty'>): Logger {
  return pino({
    level: config.logLevel,
    base: { service: 'lead-intake-gateway' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(config.logPretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } } }
      : {}),
  });
}
