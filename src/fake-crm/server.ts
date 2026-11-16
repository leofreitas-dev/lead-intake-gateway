// A fake CRM that runs as its own process, to prove the delivery under failure.
// It keeps every call it received and every contact it holds, in a JSON file,
// so a test (and later the chaos report) can audit exactly what arrived.
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import type { CrmContact } from '../crm/types.ts';
import { RateLimiter } from '../gateway/rate-limiter.ts';
import type { Logger } from '../logger.ts';

export const MODES = ['ok', 'down', '429', '500', 'slow'] as const;
export type Mode = (typeof MODES)[number];
export const isMode = (m: unknown): m is Mode => MODES.includes(m as Mode);

export const MODE_HELP: Record<Mode, string> = {
  ok: 'answers normally (and still says 429 above its own rate limit)',
  down: 'drops every connection, like a server that is off',
  '429': 'answers 429 Too Many Requests with Retry-After',
  '500': 'answers 500 Internal Server Error',
  slow: 'saves the contact but answers only after a long pause (the caller times out)',
};

export interface StoredContact {
  id: string;
  external_id: string;
  data: CrmContact;
  version: number;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallRecord {
  n: number;
  at: string;
  method: string;
  external_id: string | null;
  mode: Mode;
  status: number | 'dropped';
  trace_id: string | null;
}

export interface CrmState {
  contacts: Record<string, StoredContact>;
  calls: CallRecord[];
  nextId: number;
}

export interface FakeCrmOptions {
  mode?: Mode;
  /** The CRM's own limit: above it, even in "ok" mode, it answers 429. */
  rateLimitPerSec?: number;
  /** How long "slow" waits before answering. */
  slowMs?: number;
  /** Where the state is kept between restarts. No file: memory only. */
  storeFile?: string;
  log: Logger;
  now?: () => number;
}

export function buildFakeCrm(opts: FakeCrmOptions) {
  const now = opts.now ?? Date.now;
  let mode: Mode = opts.mode ?? 'ok';
  let slowMs = opts.slowMs ?? 5_000;
  const limiter = new RateLimiter({ perSecond: opts.rateLimitPerSec ?? 10, burst: opts.rateLimitPerSec ?? 10, now });
  const state: CrmState = load(opts.storeFile);
  const save = () => {
    if (!opts.storeFile) return;
    fs.mkdirSync(path.dirname(opts.storeFile), { recursive: true });
    const tmp = `${opts.storeFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, opts.storeFile); // never a half-written file
  };
  const record = (call: Omit<CallRecord, 'n' | 'at' | 'mode'>) => {
    state.calls.push({ n: state.calls.length + 1, at: new Date(now()).toISOString(), mode, ...call });
    save();
  };

  const app = Fastify({ loggerInstance: opts.log, disableRequestLogging: true });

  // "down": the connection is dropped before any answer, like a server that is off.
  app.addHook('onRequest', async (request, reply) => {
    if (mode === 'down' && request.url.startsWith('/contacts/')) {
      record({ method: request.method, external_id: decodeURIComponent(request.url.slice('/contacts/'.length)), status: 'dropped', trace_id: traceOf(request.headers) });
      reply.hijack();
      request.raw.socket.destroy();
    }
  });

  app.put<{ Params: { externalId: string }; Body: CrmContact }>('/contacts/:externalId', async (request, reply) => {
    const externalId = request.params.externalId;
    const traceId = traceOf(request.headers);
    const answer = (status: number) => record({ method: 'PUT', external_id: externalId, status, trace_id: traceId });

    if (mode === '429' || !limiter.take('all').allowed) {
      answer(429);
      return reply.code(429).header('retry-after', '2').send({ error: 'rate_limited' });
    }
    if (mode === '500') {
      answer(500);
      return reply.code(500).send({ error: 'internal_error' });
    }
    const body = request.body;
    if (!body || typeof body !== 'object' || body.externalId !== externalId) {
      answer(422);
      return reply.code(422).send({ error: 'externalId in the body must match the URL' });
    }

    // The upsert: the external id decides whether this is a new record or an update.
    const at = new Date(now()).toISOString();
    const existing = state.contacts[externalId];
    const contact: StoredContact = existing
      ? { ...existing, data: body, version: existing.version + 1, updated_at: at }
      : { id: `crm_${String(state.nextId++).padStart(6, '0')}`, external_id: externalId, data: body, version: 1, merged_into: null, created_at: at, updated_at: at };
    state.contacts[externalId] = contact;
    // Contacts found to be the same person are folded into this one, like a CRM merge.
    for (const mergedId of body.mergedExternalIds ?? []) {
      const other = state.contacts[mergedId];
      if (other && other.merged_into === null && mergedId !== externalId) other.merged_into = contact.id;
    }

    if (mode === 'slow') {
      // Saved already; the answer comes too late for the caller, who will retry.
      answer(200);
      await new Promise((r) => setTimeout(r, slowMs));
      return reply.code(200).send({ id: contact.id, created: !existing, version: contact.version });
    }
    answer(existing ? 200 : 201);
    return reply.code(existing ? 200 : 201).send({ id: contact.id, created: !existing, version: contact.version });
  });

  // Admin: not part of the CRM API, it is how the demo and tests control and audit it.
  app.get('/_admin/state', async () => ({ mode, slowMs, ...summary(state), contacts: Object.values(state.contacts), recentCalls: state.calls.slice(-50) }));
  app.get('/_admin/calls', async () => state.calls);
  app.post<{ Body: { mode?: string; slowMs?: number } }>('/_admin/mode', async (request, reply) => {
    const next = request.body?.mode;
    if (!isMode(next)) return reply.code(400).send({ error: `mode must be one of: ${MODES.join(', ')}` });
    mode = next;
    if (request.body.slowMs) slowMs = request.body.slowMs;
    opts.log.warn({ mode }, `fake CRM mode is now "${mode}": ${MODE_HELP[mode]}`);
    return { mode };
  });
  app.post('/_admin/reset', async () => {
    state.contacts = {};
    state.calls = [];
    state.nextId = 1;
    save();
    return { reset: true };
  });

  return Object.assign(app, { state, getMode: () => mode });
}

/** Counts used by the admin page and the chaos report. */
export function summary(state: CrmState) {
  const contacts = Object.values(state.contacts);
  const byStatus: Record<string, number> = {};
  for (const c of state.calls) byStatus[String(c.status)] = (byStatus[String(c.status)] ?? 0) + 1;
  return {
    calls: state.calls.length,
    callsByStatus: byStatus,
    contactRecords: contacts.length,
    activeContacts: contacts.filter((c) => c.merged_into === null).length,
  };
}

function load(file: string | undefined): CrmState {
  if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return { contacts: {}, calls: [], nextId: 1 };
}

function traceOf(headers: Record<string, unknown>): string | null {
  const v = headers['x-request-id'];
  return typeof v === 'string' ? v : null;
}
