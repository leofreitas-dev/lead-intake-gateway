import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import type { GatewayConfig } from '../src/config.ts';
import { createPool } from '../src/db/database.ts';
import { migrate } from '../src/db/migrate.ts';
import { signatureHeader } from '../src/gateway/signature.ts';
import { createTestDatabase, silentLog, testGatewayConfig, type TestDatabase } from './helpers.ts';

const NOW_MS = Date.UTC(2026, 10, 16, 13, 0, 0);
const NOW_SEC = NOW_MS / 1000;
const gateway = testGatewayConfig();

const LEAD = JSON.stringify({
  name: 'Emily Carter',
  email: 'Emily.Carter@example.test',
  phone: '(212) 555-0147',
  message: 'Interested in the 3-bedroom on Maple Ave.',
});

interface SendOptions {
  source?: string;
  body?: string;
  secret?: string;
  signedAtSec?: number;
  headers?: Record<string, string>;
  contentType?: string;
  ip?: string;
}

function send(app: App, opts: SendOptions = {}) {
  const source = opts.source ?? 'form';
  const body = opts.body ?? LEAD;
  const secret = opts.secret ?? gateway.secrets[source as keyof GatewayConfig['secrets']] ?? 'none-0000000000000000';
  return app.inject({
    method: 'POST',
    url: `/webhooks/${source}`,
    payload: body,
    remoteAddress: opts.ip ?? '203.0.113.10',
    headers: {
      'content-type': opts.contentType ?? 'application/json',
      'x-signature': signatureHeader(secret, body, opts.signedAtSec ?? NOW_SEC),
      ...opts.headers,
    },
  });
}

async function counts(db: TestDatabase) {
  const { rows } = await db.pool.query<{ inbox: number; jobs: number }>(
    'select (select count(*)::int from inbox) as inbox, (select count(*)::int from jobs) as jobs',
  );
  return rows[0];
}

describe('POST /webhooks/:source', () => {
  let db: TestDatabase;
  let app: App;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    app = buildApp({ pool: db.pool, log: silentLog, gateway, now: () => NOW_MS });
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('truncate inbox, jobs cascade');
  });

  describe('a valid lead', () => {
    it('is stored raw, queued for processing in the same step, and answered 202', async () => {
      const res = await send(app);
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body).toMatchObject({ duplicate: false });
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

      const inbox = await db.pool.query('select * from inbox');
      expect(inbox.rows).toHaveLength(1);
      expect(inbox.rows[0]).toMatchObject({ id: body.id, source: 'form', body: LEAD, parse_error: null, idempotency_from: 'body-hash' });

      const jobs = await db.pool.query('select * from jobs');
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0]).toMatchObject({ kind: 'process', inbox_id: body.id, status: 'pending', trace_id: body.trace_id });
    });

    it('starts the trace id here and keeps it on the inbox row and the job', async () => {
      const res = await send(app);
      const { trace_id } = res.json();
      expect(res.headers['x-request-id']).toBe(trace_id);
      const { rows } = await db.pool.query('select i.trace_id as inbox_trace, j.trace_id as job_trace from inbox i join jobs j on j.inbox_id = i.id');
      expect(rows[0]).toEqual({ inbox_trace: trace_id, job_trace: trace_id });
    });

    it("keeps the sender's trace id when it sends one", async () => {
      const res = await send(app, { headers: { 'x-request-id': 'n8n-exec-4711' } });
      expect(res.json().trace_id).toBe('n8n-exec-4711');
    });

    it('does not store credentials headers', async () => {
      await send(app, { headers: { authorization: 'Bearer something', cookie: 'a=b' } });
      const { rows } = await db.pool.query('select headers from inbox');
      expect(rows[0].headers).not.toHaveProperty('authorization');
      expect(rows[0].headers).not.toHaveProperty('cookie');
      expect(rows[0].headers).toHaveProperty('x-signature');
    });

    it('accepts a JSON content type with a charset', async () => {
      expect((await send(app, { contentType: 'application/json; charset=utf-8' })).statusCode).toBe(202);
    });

    it('works for every channel', async () => {
      for (const source of ['form', 'email', 'whatsapp', 'portal']) {
        expect((await send(app, { source })).statusCode).toBe(202);
      }
      expect(await counts(db)).toEqual({ inbox: 4, jobs: 4 });
    });
  });

  describe('the same webhook sent again', () => {
    it('gets the same id and the original trace id, and is stored once', async () => {
      const first = (await send(app)).json();
      const again = await send(app);
      const third = await send(app);
      expect(again.statusCode).toBe(202);
      expect(again.json()).toEqual({ id: first.id, trace_id: first.trace_id, duplicate: true });
      expect(await counts(db)).toEqual({ inbox: 1, jobs: 1 });
      expect((await db.pool.query('select resends from inbox')).rows[0].resends).toBe(2);
      expect(await counts(db)).toEqual({ inbox: 1, jobs: 1 });
    });

    it('is recognised by its event id even if the body changed', async () => {
      const first = (await send(app, { headers: { 'x-event-id': 'evt_123' } })).json();
      const again = (await send(app, { headers: { 'x-event-id': 'evt_123' }, body: LEAD.replace('Maple', 'Oak') })).json();
      expect(again).toMatchObject({ id: first.id, duplicate: true });
      expect(await counts(db)).toEqual({ inbox: 1, jobs: 1 });
    });

    it('from another channel is a different webhook', async () => {
      const a = (await send(app, { source: 'form' })).json();
      const b = (await send(app, { source: 'portal' })).json();
      expect(b.id).not.toBe(a.id);
      expect(await counts(db)).toEqual({ inbox: 2, jobs: 2 });
    });

    it('arriving 20 times at the same moment is still stored once', async () => {
      const responses = await Promise.all(Array.from({ length: 20 }, () => send(app)));
      expect(responses.map((r) => r.statusCode)).toEqual(Array(20).fill(202));
      expect(new Set(responses.map((r) => r.json().id)).size).toBe(1);
      expect(responses.filter((r) => r.json().duplicate === false)).toHaveLength(1);
      expect((await db.pool.query('select resends from inbox')).rows[0].resends).toBe(19);
      expect(await counts(db)).toEqual({ inbox: 1, jobs: 1 });
    });
  });

  describe('a signature problem: 401 and nothing stored', () => {
    it('wrong secret', async () => {
      const res = await send(app, { secret: 'not-the-form-secret-000000' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'signature_invalid' });
    });

    it('missing signature', async () => {
      const res = await app.inject({ method: 'POST', url: '/webhooks/form', payload: LEAD, headers: { 'content-type': 'application/json' } });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'signature_missing' });
    });

    it("another channel's secret", async () => {
      const res = await send(app, { source: 'form', secret: gateway.secrets.whatsapp });
      expect(res.statusCode).toBe(401);
    });

    it('signed 6 minutes ago (a replayed request)', async () => {
      const res = await send(app, { signedAtSec: NOW_SEC - 360 });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'timestamp_out_of_tolerance' });
    });

    it('signed 6 minutes in the future', async () => {
      const res = await send(app, { signedAtSec: NOW_SEC + 360 });
      expect(res.json()).toEqual({ error: 'timestamp_out_of_tolerance' });
    });

    afterAll(async () => {
      expect(await counts(db)).toEqual({ inbox: 0, jobs: 0 });
    });
  });

  describe('a broken payload with a valid signature', () => {
    it('is kept for a human (400), but not queued', async () => {
      const broken = '{"name": "Emily Carter", "email": ';
      const res = await send(app, { body: broken });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_payload' });
      expect(res.json().message).toMatch(/invalid JSON/);
      const { rows } = await db.pool.query('select body, parse_error from inbox');
      expect(rows).toEqual([{ body: broken, parse_error: expect.stringMatching(/invalid JSON/) }]);
      expect(await counts(db)).toEqual({ inbox: 1, jobs: 0 });
    });

    it('sent again gets the same id and is still not queued', async () => {
      const broken = 'not json at all';
      const first = (await send(app, { body: broken })).json();
      const again = await send(app, { body: broken });
      expect(again.statusCode).toBe(400);
      expect(again.json().id).toBe(first.id);
      expect(await counts(db)).toEqual({ inbox: 1, jobs: 0 });
    });

    it('JSON that is not an object (a list, a number) counts as broken', async () => {
      expect((await send(app, { body: '[1,2,3]' })).statusCode).toBe(400);
      expect((await send(app, { body: '42' })).statusCode).toBe(400);
      expect(await counts(db)).toEqual({ inbox: 2, jobs: 0 });
    });

    it('an empty body counts as broken', async () => {
      expect((await send(app, { body: '' })).statusCode).toBe(400);
    });
  });

  describe('requests refused before reading the body', () => {
    it('unknown channel: 404', async () => {
      const res = await send(app, { source: 'fax' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'unknown_source' });
    });

    it('not JSON: 415', async () => {
      expect((await send(app, { contentType: 'text/plain' })).statusCode).toBe(415);
    });

    it('larger than the body limit: 413', async () => {
      const huge = JSON.stringify({ message: 'x'.repeat(gateway.bodyLimitBytes) });
      expect((await send(app, { body: huge })).statusCode).toBe(413);
    });

    afterAll(async () => {
      expect(await counts(db)).toEqual({ inbox: 0, jobs: 0 });
    });
  });
});

describe('rate limit per channel and caller', () => {
  let db: TestDatabase;
  let app: App;
  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    app = buildApp({
      pool: db.pool,
      log: silentLog,
      gateway: testGatewayConfig({ rateLimitPerSec: 1, rateLimitBurst: 3 }),
      now: () => NOW_MS,
    });
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it('answers 429 with Retry-After once the burst is used, and stores nothing', async () => {
    const leads = [1, 2, 3, 4].map((n) => JSON.stringify({ name: `Lead ${n}`, phone: `(212) 555-010${n}` }));
    const codes = [];
    for (const body of leads) codes.push((await send(app, { body })).statusCode);
    expect(codes).toEqual([202, 202, 202, 429]);

    const refused = await send(app, { body: leads[3] });
    expect(refused.headers['retry-after']).toBe('1');
    expect(refused.json()).toEqual({ error: 'rate_limited', retry_after_s: 1 });
    const { rows } = await db.pool.query('select count(*)::int as n from inbox');
    expect(rows[0].n).toBe(3);
  });

  it('does not slow down another channel or another caller', async () => {
    expect((await send(app, { source: 'whatsapp' })).statusCode).toBe(202);
    expect((await send(app, { ip: '198.51.100.7' })).statusCode).toBe(202);
  });
});

describe('when the database cannot store the webhook', () => {
  it('answers 503 (never 202), so the sender retries', async () => {
    const deadPool = createPool('postgres://postgres:x@127.0.0.1:1/none', silentLog);
    const app = buildApp({ pool: deadPool, log: silentLog, gateway, now: () => NOW_MS });
    try {
      const res = await send(app);
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.json()).toEqual({ error: 'storage_unavailable' });
    } finally {
      await app.close();
      await deadPool.end();
    }
  });

  it('keeps no half-stored lead: if the job cannot be queued, the inbox row is rolled back', async () => {
    const db = await createTestDatabase();
    await migrate(db.pool);
    // Make queuing the job fail, after the inbox insert has already run.
    await db.pool.query(`alter table jobs add constraint test_refuse_jobs check (kind <> 'process')`);
    const app = buildApp({ pool: db.pool, log: silentLog, gateway, now: () => NOW_MS });
    try {
      const res = await send(app);
      expect(res.statusCode).toBe(503);
      expect(await counts(db)).toEqual({ inbox: 0, jobs: 0 });
    } finally {
      await app.close();
      await db.drop();
    }
  });
});
