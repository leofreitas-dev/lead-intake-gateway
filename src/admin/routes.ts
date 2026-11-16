import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AdminConfig } from '../config.ts';
import { listDeadJobs, replayDeadJobs } from '../queue/dead-letter.ts';

/**
 * Admin endpoints, for a person (or `npm run replay`), never for providers:
 *   GET  /dead-letter          the jobs that gave up, with their last error
 *   POST /replay {"ids": [..]} sends those dead jobs back to the queue
 *   POST /replay {"all": true} sends every dead job back (optionally {"kind": ...})
 * Protected by a bearer token (ADMIN_TOKEN).
 */
export async function adminRoutes(app: FastifyInstance, opts: { pool: pg.Pool; admin: AdminConfig }) {
  const { pool, admin } = opts;
  const expected = Buffer.from(`Bearer ${admin.token}`);

  app.addHook('onRequest', async (request, reply) => {
    const sent = Buffer.from(request.headers.authorization ?? '');
    if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
      return reply.code(401).send({ error: 'admin_token_required' });
    }
  });

  app.get<{ Querystring: { kind?: string } }>('/dead-letter', async (request) => {
    const jobs = await listDeadJobs(pool, { kind: request.query.kind });
    return { count: jobs.length, jobs };
  });

  app.post<{ Body: { ids?: unknown; all?: unknown; kind?: unknown } }>('/replay', async (request, reply) => {
    const body = request.body ?? {};
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : undefined;
    if (ids && (ids.length === 0 || !ids.every((id) => /^\d{1,18}$/.test(id)))) {
      return reply.code(400).send({ error: 'ids must be a non-empty list of job ids' });
    }
    // Replaying everything must be asked for explicitly: an empty body does nothing.
    if (!ids && body.all !== true) return reply.code(400).send({ error: 'send {"ids": [...]} or {"all": true}' });
    const kind = typeof body.kind === 'string' ? body.kind : undefined;
    const replayed = await replayDeadJobs(pool, ids ? { ids } : { all: true, kind });
    request.log.warn({ replayed: replayed.map((j) => j.id), by: 'admin' }, `dead-letter replay: ${replayed.length} job(s) back in the queue`);
    return { replayed: replayed.length, jobs: replayed };
  });
}
