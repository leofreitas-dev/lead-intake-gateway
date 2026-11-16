import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import type { AdminConfig } from '../config.ts';
import { listDeadJobs, replayDeadJobs } from '../queue/dead-letter.ts';
import { approveDraft, type Decision, rejectDraft } from '../replies/decide.ts';
import { type CrmStatus, dashboard, listDrafts } from './dashboard.ts';
import { schemas } from '../docs/schemas.ts';

/**
 * Admin endpoints, for a person (or `npm run replay`), never for providers:
 *   GET  /dead-letter          the jobs that gave up, with their last error
 *   POST /replay {"ids": [..]} sends those dead jobs back to the queue
 *   POST /replay {"all": true} sends every dead job back (optionally {"kind": ...})
 *   GET  /api/drafts           reply drafts waiting for a person (?status=decided: the last decisions)
 *   POST /api/drafts/:id/approve {"body"?: "..."}  approve as is, or edited: written to the outbox
 *   POST /api/drafts/:id/reject  {"reason"?: "..."}
 *   GET  /api/dashboard        the panel: channels, duplicates, queue, CRM, dead-letter, AI cost
 * All protected by a bearer token (ADMIN_TOKEN).
 */
export async function adminRoutes(app: FastifyInstance, opts: { pool: pg.Pool; admin: AdminConfig; crmStatus?: () => CrmStatus }) {
  const { pool, admin } = opts;
  const expected = Buffer.from(`Bearer ${admin.token}`);

  app.addHook('onRequest', async (request, reply) => {
    const sent = Buffer.from(request.headers.authorization ?? '');
    if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
      return reply.code(401).send({ error: 'admin_token_required' });
    }
  });

  app.get<{ Querystring: { kind?: string } }>('/dead-letter', { schema: schemas.deadLetter }, async (request) => {
    const jobs = await listDeadJobs(pool, { kind: request.query.kind });
    return { count: jobs.length, jobs };
  });

  app.post<{ Body: { ids?: unknown; all?: unknown; kind?: unknown } }>('/replay', { schema: schemas.replay }, async (request, reply) => {
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

  // --- The approval screen's data (same token). ---

  app.get<{ Querystring: { status?: string } }>('/api/drafts', { schema: schemas.listDrafts }, async (request, reply) => {
    const which = request.query.status ?? 'waiting';
    if (which !== 'waiting' && which !== 'decided') return reply.code(400).send({ error: 'status must be "waiting" or "decided"' });
    const drafts = await listDrafts(pool, which);
    return { count: drafts.length, drafts };
  });

  app.post<{ Params: { id: string }; Body: { body?: unknown } }>('/api/drafts/:id/approve', { schema: schemas.approve }, async (request, reply) => {
    const body = request.body?.body;
    if (body !== undefined && typeof body !== 'string') return reply.code(400).send({ error: 'body must be text' });
    const result = await approveDraft(pool, { id: request.params.id, body, by: 'admin', outboxDir: admin.outboxDir });
    if (result.ok) request.log.info({ draft_id: result.draftId, decision: result.status, outbox_file: result.outboxFile }, `reply ${result.status}: written to the outbox, not sent`);
    return answer(reply, result);
  });

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>('/api/drafts/:id/reject', { schema: schemas.reject }, async (request, reply) => {
    const reason = typeof request.body?.reason === 'string' ? request.body.reason : undefined;
    const result = await rejectDraft(pool, { id: request.params.id, reason, by: 'admin' });
    if (result.ok) request.log.info({ draft_id: result.draftId }, 'reply rejected: it never goes out');
    return answer(reply, result);
  });

  app.get('/api/dashboard', { schema: schemas.dashboard }, async () => dashboard(pool, opts.crmStatus?.()));
}

const STATUS_OF_ERROR = { not_found: 404, already_decided: 409, empty_reply: 400, too_long: 400 } as const;

function answer(reply: FastifyReply, result: Decision) {
  if (result.ok) return { status: result.status, draft_id: result.draftId, outbox_file: result.outboxFile };
  return reply.code(STATUS_OF_ERROR[result.error]).send({ error: result.error, ...(result.status ? { status: result.status } : {}) });
}
