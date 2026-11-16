import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RecordedClassifier } from '../src/ai/classifier.ts';
import { loadPriceList } from '../src/ai/pricing.ts';
import { HttpCrmClient } from '../src/crm/http-crm.ts';
import { type CrmClient, CrmError } from '../src/crm/types.ts';
import { migrate } from '../src/db/migrate.ts';
import { createDelivery, DELIVER_JOB } from '../src/delivery/deliver-job.ts';
import { buildFakeCrm } from '../src/fake-crm/server.ts';
import { loadFixture } from '../src/fixtures.ts';
import { storeWebhook } from '../src/gateway/inbox.ts';
import { CLASSIFY_JOB, makeClassifyHandler } from '../src/leads/classify-job.ts';
import { processLead } from '../src/leads/process.ts';
import { listDeadJobs, replayDeadJobs } from '../src/queue/dead-letter.ts';
import { drain, runOneLeasedJob } from '../src/queue/worker.ts';
import type { Source } from '../src/sources.ts';
import { createTestDatabase, silentLog, type TestDatabase, until } from './helpers.ts';

describe('delivery to the CRM', () => {
  let db: TestDatabase;
  let crm: ReturnType<typeof buildFakeCrm>;
  let crmUrl: string;
  const classify = makeClassifyHandler({ classifier: new RecordedClassifier(), prices: loadPriceList() });

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    crm = buildFakeCrm({ log: silentLog, rateLimitPerSec: 10_000 });
    await crm.listen({ port: 0, host: '127.0.0.1' });
    crmUrl = `http://127.0.0.1:${(crm.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await crm.close();
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('truncate ai_calls, lead_classifications, lead_routes, crm_sync, contact_events, leads, contact_identifiers, contacts, jobs, inbox cascade');
    await crm.inject({ method: 'POST', url: '/_admin/reset' });
    await setMode('ok');
  });

  const setMode = (mode: string, slowMs?: number) => crm.inject({ method: 'POST', url: '/_admin/mode', payload: { mode, slowMs } });
  const crmState = async () => (await crm.inject({ method: 'GET', url: '/_admin/state' })).json();
  const delivery = (over: Partial<Parameters<typeof createDelivery>[0]> = {}) =>
    createDelivery({
      pool: db.pool,
      log: silentLog,
      crm: new HttpCrmClient({ baseUrl: crmUrl, timeoutMs: 3_000 }),
      maxAttempts: 10,
      backoffBaseMs: 1,
      backoffMaxMs: 5,
      breakerThreshold: 3,
      breakerCooldownMs: 150,
      rateLimitPerSec: 1_000,
      rateLimitBurst: 1_000,
      ...over,
    });

  /** Leads arrive and go through identity and classification, exactly as in production. */
  async function leadsArrive(...fixtures: [Source, string][]) {
    for (const [source, fixture] of fixtures) {
      await storeWebhook(db.pool, {
        source,
        idempotency: { key: `key:${randomUUID()}`, from: 'idempotency-key' },
        headers: {},
        rawBody: loadFixture(source, fixture).body,
        traceId: `trace-${fixture}`,
        remoteAddr: '127.0.0.1',
        parseError: undefined,
      });
    }
    await drain({ pool: db.pool, log: silentLog, kind: 'process', handler: processLead, concurrency: 1 });
    await drain({ pool: db.pool, log: silentLog, kind: CLASSIFY_JOB, handler: classify, concurrency: 1 });
  }
  const deliverJobs = async () =>
    (await db.pool.query(`select id, status, attempts, last_error, replays from jobs where kind = $1 order by id`, [DELIVER_JOB])).rows;

  it('Emily by 3 channels: 3 deliveries, ONE record in the CRM (upsert by external id), with the trace id', async () => {
    await leadsArrive(['form', 'lead-01'], ['whatsapp', 'lead-02'], ['portal', 'lead-03']);
    expect(await deliverJobs()).toHaveLength(3);
    const counts = await drain(delivery());
    expect(counts).toMatchObject({ done: 3, retry: 0, dead: 0 });

    const state = await crmState();
    expect(state.activeContacts).toBe(1);
    expect(state.contacts[0]).toMatchObject({ version: 3, data: { name: 'Emily Carter', leadCount: 3, phones: ['+12125550147'], sources: ['form', 'whatsapp', 'portal'] } });
    expect(state.recentCalls.map((c: { trace_id: string }) => c.trace_id).sort()).toEqual(['trace-lead-01', 'trace-lead-02', 'trace-lead-03']);
    expect((await db.pool.query('select deliveries from crm_sync')).rows).toEqual([{ deliveries: 3 }]);
  });

  it('spam is never delivered', async () => {
    await leadsArrive(['form', 'lead-05']);
    expect(await deliverJobs()).toHaveLength(0);
  });

  it('CRM down: jobs retry, the breaker opens after 3 failures and holds the rest; CRM back → the queue drains', async () => {
    await leadsArrive(['whatsapp', 'lead-04'], ['email', 'lead-06'], ['portal', 'lead-07'], ['form', 'lead-08'], ['form', 'lead-11']);
    await setMode('down');
    const d = delivery();
    for (let i = 0; i < 3; i++) expect(await runOneLeasedJob(d)).toBe('retry');
    expect(d.breaker.current).toBe('open');
    expect(d.breaker.waitMs()).toBeGreaterThan(0); // nobody takes a job now
    // While open, the other jobs were not touched: their attempts are intact.
    expect((await deliverJobs()).map((j) => j.attempts)).toEqual([1, 1, 1, 0, 0]);
    expect((await deliverJobs())[0].last_error).toMatch(/CRM unreachable/);

    await setMode('ok');
    const counts = await drain(d); // waits out the cooldown, one trial, then everything
    expect(counts.dead).toBe(0);
    expect(d.breaker.current).toBe('closed');
    expect((await deliverJobs()).every((j) => j.status === 'done')).toBe(true);
    expect((await crmState()).activeContacts).toBe(5);
  });

  it('the trial delivery fails while the CRM is still down → the breaker opens again', async () => {
    await leadsArrive(['whatsapp', 'lead-04']);
    await setMode('500');
    const d = delivery({ breakerThreshold: 1 });
    await runOneLeasedJob(d);
    expect(d.breaker.current).toBe('open');
    await new Promise((r) => setTimeout(r, 200));
    expect(d.breaker.waitMs()).toBe(0); // the trial
    await new Promise((r) => setTimeout(r, 10)); // its backoff
    expect(await runOneLeasedJob(d)).toBe('retry');
    expect(d.breaker.current).toBe('open');
  });

  it('out of attempts → dead-letter; replay sends it back and it is delivered once', async () => {
    await leadsArrive(['whatsapp', 'lead-04']);
    await setMode('500');
    const d = delivery({ maxAttempts: 3, breakerThreshold: 100 });
    // drain() stops when nothing is ready; a retry is ready again after its (tiny) backoff.
    const outcomes: string[] = [];
    while (!outcomes.includes('dead')) {
      outcomes.push(await runOneLeasedJob(d));
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(outcomes.filter((o) => o !== 'empty')).toEqual(['retry', 'retry', 'dead']);
    const [dead] = await listDeadJobs(db.pool);
    expect(dead).toMatchObject({ kind: DELIVER_JOB, attempts: 3, replays: 0 });
    expect(dead.last_error).toMatch(/CRM error 500/);

    await setMode('ok');
    const replayed = await replayDeadJobs(db.pool, { ids: [dead.id] });
    expect(replayed.map((j) => j.id)).toEqual([dead.id]);
    expect(await replayDeadJobs(db.pool, { ids: [dead.id] })).toEqual([]); // twice by mistake: nothing happens
    expect(await drain(d)).toMatchObject({ done: 1, dead: 0 });
    expect(await deliverJobs()).toMatchObject([{ status: 'done', attempts: 1, replays: 1 }]);
    expect((await crmState()).activeContacts).toBe(1);
  });

  it('429: waits for Retry-After, without counting against the breaker', async () => {
    await leadsArrive(['whatsapp', 'lead-04']);
    await setMode('429');
    const d = delivery({ breakerThreshold: 1 });
    expect(await runOneLeasedJob(d)).toBe('retry');
    expect(d.breaker.current).toBe('closed');
    const { rows } = await db.pool.query(`select run_at - updated_at >= interval '2 seconds' as waits from jobs where kind = $1`, [DELIVER_JOB]);
    expect(rows[0].waits).toBe(true); // Retry-After: 2 s, more than the 5 ms backoff
  });

  it('slow CRM: it saved the contact but answered too late; the retry updates the same record', async () => {
    await leadsArrive(['whatsapp', 'lead-04']);
    // The CRM answers after 3 s; this client gives up after 0.3 s.
    await setMode('slow', 3_000);
    const d = delivery({ breakerThreshold: 100, crm: new HttpCrmClient({ baseUrl: crmUrl, timeoutMs: 300 }) });
    expect(await runOneLeasedJob(d)).toBe('retry');
    await until(async () => (await crmState()).contactRecords === 1); // saved anyway
    await setMode('ok');
    await until(async () => (await db.pool.query(`select run_at <= now() as ready from jobs where kind = $1`, [DELIVER_JOB])).rows[0].ready);
    expect(await drain(d)).toMatchObject({ done: 1 });
    const state = await crmState();
    expect(state.contactRecords).toBe(1);
    expect(state.contacts[0].version).toBe(2);
  });

  it('the contact changes while its delivery is in flight → it is sent again as it is now', async () => {
    await leadsArrive(['whatsapp', 'lead-04']);
    const http = new HttpCrmClient({ baseUrl: crmUrl, timeoutMs: 3_000 });
    const sent: string[] = [];
    const changingMidway: CrmClient = {
      name: 'fake-crm',
      upsertContact: async (contact, ctx) => {
        sent.push(contact.name ?? '');
        // While the first call is on its way, a newer lead renames the contact
        // (and that lead's own delivery may already have landed).
        if (sent.length === 1) await db.pool.query(`update contacts set display_name = 'Marcus Webb'`);
        return http.upsertContact(contact, ctx);
      },
    };
    expect(await drain(delivery({ crm: changingMidway }))).toMatchObject({ done: 1 });
    expect(sent).toEqual(['Marcus', 'Marcus Webb']);
    expect((await crmState()).contacts[0].data.name).toBe('Marcus Webb');
  });

  it('a 4xx (our data refused) goes to dead-letter at once, without burning 10 attempts', async () => {
    await leadsArrive(['whatsapp', 'lead-04']);
    const refusing: CrmClient = {
      name: 'strict-crm',
      upsertContact: async () => {
        throw new CrmError('rejected', 'CRM refused the contact (422)', { status: 422 });
      },
    };
    const d = delivery({ crm: refusing });
    expect(await drain(d)).toMatchObject({ dead: 1, retry: 0 });
    expect(d.breaker.current).toBe('closed');
  });

  it('a merge reaches the CRM: "Dan B" is folded into Daniel, one active contact', async () => {
    await leadsArrive(['form', 'lead-08'], ['whatsapp', 'lead-09']);
    await drain(delivery());
    expect((await crmState()).activeContacts).toBe(2); // two people, as far as anyone knew

    await leadsArrive(['portal', 'lead-10']); // proves they are one person
    await drain(delivery());
    const state = await crmState();
    expect(state.contactRecords).toBe(2);
    expect(state.activeContacts).toBe(1);
    const daniel = state.contacts.find((c: { merged_into: string | null }) => c.merged_into === null);
    expect(daniel.data).toMatchObject({ name: 'Daniel Brooks', leadCount: 3, mergedExternalIds: [expect.stringMatching(/^lig_contact_/)] });
  });

  it('a delivery job queued for a contact that was merged since then delivers the survivor', async () => {
    await leadsArrive(['form', 'lead-08'], ['whatsapp', 'lead-09'], ['portal', 'lead-10']);
    await drain(delivery());
    const state = await crmState();
    expect(state.contactRecords).toBe(1); // Dan B was never sent on its own
    expect(state.contacts[0].data.name).toBe('Daniel Brooks');
  });
});
