import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type pg from 'pg';
import type { Logger } from './logger.ts';

export interface AppDeps {
  pool: pg.Pool;
  log: Logger;
}

const TRACE_HEADER = 'x-request-id';
const READY_TIMEOUT_MS = 2_000;

export type App = ReturnType<typeof buildApp>;

export function buildApp({ pool, log }: AppDeps) {
  const app = Fastify({
    loggerInstance: log,
    // Keep the caller's trace id if it sends one, so one id follows the request
    // across systems; otherwise start a new one.
    requestIdHeader: TRACE_HEADER,
    genReqId: () => randomUUID(),
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header(TRACE_HEADER, request.id);
  });

  // Liveness: the process is up and answering. Never touches the database,
  // so a slow database does not make an orchestrator restart a healthy process.
  app.get('/health', async () => ({ status: 'ok', uptime_s: Math.round(process.uptime()) }));

  // Readiness: the process can do real work, which needs the database.
  app.get('/ready', async (request, reply) => {
    try {
      await withTimeout(pool.query('select 1'), READY_TIMEOUT_MS);
      return { status: 'ready', db: 'ok' };
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'readiness check failed');
      return reply.code(503).send({ status: 'not_ready', db: 'down' });
    }
  });

  return app;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
