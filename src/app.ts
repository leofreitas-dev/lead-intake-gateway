import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type pg from 'pg';
import type { CrmStatus } from './admin/dashboard.ts';
import { consolePage } from './admin/page.ts';
import { adminRoutes } from './admin/routes.ts';
import type { AdminConfig, GatewayConfig } from './config.ts';
import { webhookRoutes } from './gateway/routes.ts';
import type { Logger } from './logger.ts';

export interface AppDeps {
  pool: pg.Pool;
  log: Logger;
  gateway: GatewayConfig;
  /** Admin endpoints (dead-letter, replay) and the approval screen. Left out, they are not served. */
  admin?: AdminConfig;
  /** The CRM's state as this process sees it (the circuit breaker), for the panel. */
  crmStatus?: () => CrmStatus;
  /** Clock for signature and rate-limit checks. Injected in tests. */
  now?: () => number;
}

const TRACE_HEADER = 'x-request-id';
const READY_TIMEOUT_MS = 2_000;
const SAFE_TRACE_ID = /^[A-Za-z0-9._:-]{1,100}$/;

export type App = ReturnType<typeof buildApp>;

export function buildApp({ pool, log, gateway, admin, crmStatus, now }: AppDeps) {
  const app = Fastify({
    loggerInstance: log,
    // Keep the caller's trace id if it sends a sane one, so one id follows the
    // request across systems; otherwise start a new one. The id ends up in logs
    // and in the database, so odd characters or huge values are not trusted.
    requestIdHeader: false,
    genReqId: (req) => {
      const sent = req.headers[TRACE_HEADER];
      return typeof sent === 'string' && SAFE_TRACE_ID.test(sent) ? sent : randomUUID();
    },
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

  app.register(webhookRoutes, { pool, config: gateway, now });
  if (admin) {
    app.register(adminRoutes, { pool, admin, crmStatus });
    // The approval screen. The page itself holds no data: it asks for the admin
    // token and calls the /api routes above, which check it on every request.
    app.get('/', async (_request, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        // Nothing from the internet: scripts, styles and requests stay on this server.
        .header('content-security-policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
        .header('x-content-type-options', 'nosniff')
        .send(consolePage(admin.usingDemoToken)),
    );
  }

  return app;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
