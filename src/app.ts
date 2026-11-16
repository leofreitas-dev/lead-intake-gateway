import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerDocs } from './docs/openapi.ts';
import { schemas } from './docs/schemas.ts';
import type pg from 'pg';
import type { CrmStatus } from './admin/dashboard.ts';
import { consolePage } from './admin/page.ts';
import { adminRoutes } from './admin/routes.ts';
import type { AdminConfig, GatewayConfig } from './config.ts';
import { webhookRoutes } from './gateway/routes.ts';
import type { Logger } from './logger.ts';
import { Metrics, METRICS_CONTENT_TYPE } from './observability/metrics.ts';

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
  /** Also export Node's own process metrics (CPU, memory, event loop) on /metrics. Off in tests. */
  processMetrics?: boolean;
}

const TRACE_HEADER = 'x-request-id';
const READY_TIMEOUT_MS = 2_000;
const SAFE_TRACE_ID = /^[A-Za-z0-9._:-]{1,100}$/;

export type App = ReturnType<typeof buildApp>;

export function buildApp({ pool, log, gateway, admin, crmStatus, now, processMetrics = false }: AppDeps) {
  const metrics = new Metrics({ pool, crmStatus, processMetrics });
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

  // Route schemas are documentation (for /docs): the handlers check their own
  // inputs, as they always did, and answers are plain JSON.stringify, so a
  // schema can never silently drop a field from an answer.
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  // First the docs, then every route (as plugins, so the docs see them all).
  registerDocs(app);
  app.register(async (routes) => coreRoutes(routes));
  app.register(webhookRoutes, { pool, config: gateway, now, metrics });
  if (admin) {
    app.register(adminRoutes, { pool, admin, crmStatus });
    app.register(async (routes) => consoleRoute(routes, admin));
  }
  return app;

  function coreRoutes(app: FastifyInstance) {
  // Liveness: the process is up and answering. Never touches the database,
  // so a slow database does not make an orchestrator restart a healthy process.
  app.get('/health', { schema: schemas.health }, async () => ({ status: 'ok', uptime_s: Math.round(process.uptime()) }));

  // Readiness: the process can do real work, which needs the database.
  app.get('/ready', { schema: schemas.ready }, async (request, reply) => {
    try {
      await withTimeout(pool.query('select 1'), READY_TIMEOUT_MS);
      return { status: 'ready', db: 'ok' };
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'readiness check failed');
      return reply.code(503).send({ status: 'not_ready', db: 'down' });
    }
  });

  // Prometheus scrapes this. Counts only, no personal data. Not behind the admin
  // token, like most /metrics endpoints: the server listens on 127.0.0.1 by default.
  app.get('/metrics', { schema: schemas.metrics }, async (_request, reply) => reply.type(METRICS_CONTENT_TYPE).send(await metrics.render()));
  }
}

/** The approval screen. The page holds no data: it asks for the admin token and calls /api, which checks it on every request. */
function consoleRoute(app: FastifyInstance, admin: AdminConfig) {
  app.get('/', { schema: schemas.console }, async (_request, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      // Nothing from the internet: scripts, styles and requests stay on this server.
      .header('content-security-policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
      .header('x-content-type-options', 'nosniff')
      .send(consolePage(admin.usingDemoToken)),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
