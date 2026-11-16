import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ModelReply } from '../src/ai/classifier.ts';
import { loadPriceList } from '../src/ai/pricing.ts';
import { buildApp } from '../src/app.ts';
import { migrate } from '../src/db/migrate.ts';
import { CircuitBreaker } from '../src/delivery/circuit-breaker.ts';
import { storeWebhook } from '../src/gateway/inbox.ts';
import { CLASSIFY_JOB, makeClassifyHandler } from '../src/leads/classify-job.ts';
import { processLead } from '../src/leads/process.ts';
import { drain } from '../src/queue/worker.ts';
import { DRAFT_JOB, makeDraftHandler } from '../src/replies/draft-job.ts';
import { createTestDatabase, silentLog, testGatewayConfig, type TestDatabase } from './helpers.ts';

const TOKEN = 'test-admin-token-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const prices = loadPriceList();
const REPLY = 'Hi {first_name}, thank you for your message. An agent from our buyer team will contact you. Juniper Lane Realty';

const answers: Record<string, object> = {
  buyer: { intent: 'buy', urgency: 'medium', budget_band: 'not_stated', language: 'en', confidence: 0.9, evidence: 'Wants a studio.' },
  spam: { intent: 'spam', urgency: 'low', budget_band: 'not_stated', language: 'en', confidence: 0.97, evidence: 'SEO offer.' },
};
/** One fake model for both jobs: classification from the message's first word, drafts always REPLY. */
const ai = {
  mode: 'live' as const,
  model: 'claude-haiku-5-5',
  async complete(req: { system: string; user: string }): Promise<ModelReply> {
    const text = req.system.includes('first reply')
      ? JSON.stringify({ language: 'en', body: REPLY })
      : JSON.stringify(answers[req.user.includes('SEO') ? 'spam' : 'buyer']);
    return { text, stopReason: 'end_turn', model: 'claude-haiku-5-5', inputTokens: 200, outputTokens: 50 };
  },
};

describe('the approval console: page and /api routes', () => {
  let db: TestDatabase;
  let outbox: string;
  let app: ReturnType<typeof buildApp>;
  const breaker = new CircuitBreaker({ destination: 'fake-crm', failureThreshold: 3, cooldownMs: 30_000 });

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lig-console-'));
    app = buildApp({
      pool: db.pool, log: silentLog, gateway: testGatewayConfig(),
      admin: { token: TOKEN, usingDemoToken: false, outboxDir: outbox },
      crmStatus: () => ({ url: 'http://127.0.0.1:4010', breaker: breaker.snapshot() }),
    });
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('truncate reply_drafts, ai_calls, lead_classifications, lead_routes, contact_events, leads, contact_identifiers, contacts, jobs, inbox, crm_sync cascade');
    for (const f of fs.readdirSync(outbox)) fs.rmSync(path.join(outbox, f));
  });

  async function arrive(source: 'form' | 'email', body: object, key: string = randomUUID()) {
    return storeWebhook(db.pool, {
      source, idempotency: { key, from: 'idempotency-key' }, headers: {}, rawBody: JSON.stringify(body),
      traceId: `trace-${key}`, remoteAddr: '127.0.0.1', parseError: undefined,
    });
  }
  async function runEverything() {
    await drain({ pool: db.pool, log: silentLog, kind: 'process', handler: processLead, concurrency: 1 });
    await drain({ pool: db.pool, log: silentLog, kind: CLASSIFY_JOB, handler: makeClassifyHandler({ classifier: ai, prices }) });
    await drain({ pool: db.pool, log: silentLog, kind: DRAFT_JOB, handler: makeDraftHandler({ drafter: ai, prices }) });
  }
  /** Two buyers (one resent), one spam: two drafts waiting. */
  async function seed() {
    await arrive('form', { name: 'Emily Carter', email: 'emily.carter@example.test', phone: '(212) 555-0147', message: 'Looking for a studio in Midtown.' }, 'k1');
    await arrive('form', { name: 'Emily Carter', email: 'emily.carter@example.test', phone: '(212) 555-0147', message: 'Looking for a studio in Midtown.' }, 'k1');
    await arrive('email', { from: { name: 'Marcus Lee', email: 'marcus.lee@example.test' }, subject: 'Condo', text: 'A condo to buy, please.' });
    await arrive('form', { name: 'Growth Team', email: 'growth@seo.test', message: 'SEO services for your site!' });
    await runEverything();
  }
  const get = (url: string, headers = auth) => app.inject({ method: 'GET', url, headers });
  const post = (url: string, payload: object = {}, headers = auth) => app.inject({ method: 'POST', url, headers, payload });

  describe('the page', () => {
    it('is served at / with no data in it, and nothing loaded from the internet', async () => {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['content-security-policy']).toContain("connect-src 'self'");
      // No CDN, no web fonts, no remote scripts or styles: works offline.
      expect(res.body).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
      expect(res.body).not.toMatch(/@import|url\(\s*["']?https?:/i);
      expect(res.body).toContain('Approvals');
      expect(res.body).toContain('Dashboard');
      expect(res.body).toContain('const DEMO_TOKEN = null;');
    });

    it('offers the demo token, with a warning, only when the demo token is in use', async () => {
      const demo = buildApp({ pool: db.pool, log: silentLog, gateway: testGatewayConfig(), admin: { token: 'demo-only-admin-token', usingDemoToken: true, outboxDir: outbox } });
      const html = (await demo.inject({ method: 'GET', url: '/' })).body;
      await demo.close();
      expect(html).toContain('const DEMO_TOKEN = "demo-only-admin-token";');
      expect(html).toContain('Demo admin token in use');
    });
  });

  it('every /api route needs the admin token', async () => {
    for (const [method, url] of [['GET', '/api/drafts'], ['GET', '/api/dashboard'], ['POST', '/api/drafts/1/approve'], ['POST', '/api/drafts/1/reject']] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
      expect((await app.inject({ method, url, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    }
  });

  it('lists the drafts waiting: original lead, what the AI understood, the route and why, the draft', async () => {
    await seed();
    const res = (await get('/api/drafts')).json();
    expect(res.count).toBe(2);
    const emily = res.drafts.find((d: { lead: { name: string } }) => d.lead.name === 'Emily Carter');
    expect(emily).toMatchObject({
      status: 'pending',
      ai_body: REPLY.replace('{first_name}', 'Emily'),
      lead: { source: 'form', email: 'emily.carter@example.test', message: 'Looking for a studio in Midtown.' },
      understood: { intent: 'buy', urgency: 'medium', confidence: 0.9, evidence: 'Wants a studio.' },
      route: { route: 'buyer_team', rule: 'buyer', reason: 'wants to buy, urgency medium' },
    });
    expect(res.drafts.map((d: { lead: { name: string } }) => d.lead.name)).not.toContain('Growth Team'); // spam: no draft
    expect((await get('/api/drafts?status=bogus')).statusCode).toBe(400);
  });

  it('approve → 200 and an outbox file; deciding again → 409', async () => {
    await seed();
    const [d] = (await get('/api/drafts')).json().drafts;
    const res = await post(`/api/drafts/${d.id}/approve`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'approved', draft_id: d.id, outbox_file: `reply-${d.id}.json` });
    expect(JSON.parse(fs.readFileSync(path.join(outbox, `reply-${d.id}.json`), 'utf8'))).toMatchObject({ body: d.ai_body, decision: 'approved' });
    expect((await post(`/api/drafts/${d.id}/approve`)).statusCode).toBe(409);
    expect((await post(`/api/drafts/${d.id}/reject`)).json()).toEqual({ error: 'already_decided', status: 'approved' });
    expect((await get('/api/drafts')).json().count).toBe(1);
    expect((await get('/api/drafts?status=decided')).json().drafts[0]).toMatchObject({ id: d.id, status: 'approved', outbox_file: `reply-${d.id}.json` });
  });

  it('edit → saved as edited with the new text; empty or non-text bodies → 400', async () => {
    await seed();
    const [d] = (await get('/api/drafts')).json().drafts;
    expect((await post(`/api/drafts/${d.id}/approve`, { body: '   ' })).statusCode).toBe(400);
    expect((await post(`/api/drafts/${d.id}/approve`, { body: 42 })).statusCode).toBe(400);
    const res = await post(`/api/drafts/${d.id}/approve`, { body: 'Hi, a shorter reply written by a person.' });
    expect(res.json()).toMatchObject({ status: 'edited' });
    expect(JSON.parse(fs.readFileSync(path.join(outbox, `reply-${d.id}.json`), 'utf8')).body).toBe('Hi, a shorter reply written by a person.');
  });

  it('reject → 200, nothing in the outbox; an unknown draft → 404', async () => {
    await seed();
    const [d] = (await get('/api/drafts')).json().drafts;
    expect((await post(`/api/drafts/${d.id}/reject`, { reason: 'duplicate of a call' })).json()).toEqual({ status: 'rejected', draft_id: d.id, outbox_file: null });
    expect(fs.readdirSync(outbox)).toEqual([]);
    expect((await post('/api/drafts/999999/approve')).statusCode).toBe(404);
    expect((await post('/api/drafts/abc/reject')).statusCode).toBe(404);
  });

  it('the dashboard: leads by channel, duplicates caught, queue, CRM and breaker, dead-letter, AI cost by purpose', async () => {
    await seed();
    await db.pool.query(`insert into jobs (kind, status, attempts, last_error) values ('deliver_crm', 'dead', 10, 'CRM error 500')`);
    breaker.failure('CRM error 500');
    const d = (await get('/api/dashboard')).json();
    expect(d.channels).toEqual([
      { source: 'email', webhooks: 1, leads: 1, resends: 0, rejected: 0 },
      { source: 'form', webhooks: 2, leads: 2, resends: 1, rejected: 0 },
    ]);
    expect(d.people).toEqual({ contacts: 3, merged_contacts: 0, leads: 3, merges: 0 });
    expect(d.queue).toContainEqual({ kind: 'deliver_crm', status: 'dead', n: 1 });
    expect(d.queue).toContainEqual({ kind: 'deliver_crm', status: 'pending', n: 2 }); // the spam is never delivered
    expect(d.drafts).toEqual({ pending: 2 });
    expect(d.crm).toMatchObject({ url: 'http://127.0.0.1:4010', contacts: 0, breaker: { state: 'closed', failuresInARow: 1, threshold: 3, lastFailure: 'CRM error 500' } });
    expect(d.dead_letter).toHaveLength(1);
    expect(d.ai.rows).toEqual([
      { purpose: 'classify', ai_mode: 'live', calls: 3, input_tokens: 600, output_tokens: 150, cost_usd: expect.any(Number) },
      { purpose: 'draft', ai_mode: 'live', calls: 2, input_tokens: 400, output_tokens: 100, cost_usd: expect.any(Number) },
    ]);
    expect(d.ai.total_usd).toBeCloseTo((1000 * 0.1 + 250 * 0.5) / 1e6, 12);
  });
});
