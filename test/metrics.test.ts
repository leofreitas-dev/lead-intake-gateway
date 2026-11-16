import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { migrate } from '../src/db/migrate.ts';
import { CircuitBreaker } from '../src/delivery/circuit-breaker.ts';
import { signatureHeader } from '../src/gateway/signature.ts';
import { createPool } from '../src/db/database.ts';
import { createTestDatabase, silentLog, testGatewayConfig, type TestDatabase } from './helpers.ts';

const gateway = testGatewayConfig({ rateLimitPerSec: 1, rateLimitBurst: 4 });
const lead = (n: number) => JSON.stringify({ name: 'Emily Carter', email: 'emily.carter@example.test', message: `Lead number ${n}` });

/** Parses the Prometheus text format into "name{labels}" → value, labels sorted. */
function parse(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(\{(.*)\})? (\S+)$/);
    if (!m) throw new Error(`not Prometheus text: ${line}`);
    const labels = m[3] ? m[3].match(/\w+="(?:[^"\\]|\\.)*"/g)!.sort().join(',') : '';
    out.set(labels ? `${m[1]}{${labels}}` : m[1], Number(m[4]));
  }
  return out;
}

describe('GET /metrics', () => {
  let db: TestDatabase;
  let app: App;
  const breaker = new CircuitBreaker({ destination: 'fake-crm', failureThreshold: 2, cooldownMs: 30_000 });

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });
  beforeEach(async () => {
    await db.pool.query('truncate reply_drafts, ai_calls, lead_classifications, lead_routes, contact_events, leads, contact_identifiers, contacts, jobs, inbox cascade');
    app = buildApp({ pool: db.pool, log: silentLog, gateway, crmStatus: () => ({ url: 'http://127.0.0.1:4010', breaker: breaker.snapshot() }) });
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  const send = (source: string, body: string, opts: { secret?: string; ip?: string; eventId?: string } = {}) =>
    app.inject({
      method: 'POST', url: `/webhooks/${source}`, payload: body, remoteAddress: opts.ip ?? '203.0.113.7',
      headers: {
        'content-type': 'application/json',
        'x-signature': signatureHeader(opts.secret ?? gateway.secrets.form, body),
        ...(opts.eventId ? { 'x-event-id': opts.eventId } : {}),
      },
    });
  /** A bare lead (and its contact) for the webhook already stored, so ai_calls can point to it. */
  const aLead = async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      `with c as (insert into contacts (display_name) values ('Emily Carter') returning id)
       insert into leads (inbox_id, contact_id, source, occurred_at, trace_id)
       select i.id, c.id, i.source, now(), i.trace_id from inbox i, c order by i.received_at limit 1 returning id`,
    );
    return rows[0].id;
  };
  const scrape = async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain; version=0.0.4');
    return { text: res.body, m: parse(res.body) };
  };

  it('counts webhooks by channel and outcome, and times them', async () => {
    expect((await send('form', lead(1), { eventId: 'e1' })).statusCode).toBe(202);
    expect((await send('form', lead(1), { eventId: 'e1' })).statusCode).toBe(202); // resend
    expect((await send('form', lead(2), { secret: 'wrong-secret-000000000000' })).statusCode).toBe(401);
    expect((await send('form', '{broken', {})).statusCode).toBe(400);
    expect((await send('form', lead(3))).statusCode).toBe(429); // burst of 4 used up
    expect((await send('nope', lead(4), { ip: '203.0.113.8' })).statusCode).toBe(404);

    const { m, text } = await scrape();
    expect(m.get('lig_webhooks_total{outcome="accepted",source="form"}')).toBe(1);
    expect(m.get('lig_webhooks_total{outcome="duplicate",source="form"}')).toBe(1);
    expect(m.get('lig_webhooks_total{outcome="bad_signature",source="form"}')).toBe(1);
    expect(m.get('lig_webhooks_total{outcome="invalid_payload",source="form"}')).toBe(1);
    expect(m.get('lig_webhooks_total{outcome="rate_limited",source="form"}')).toBe(1);
    // A made-up channel name never becomes a label of its own.
    expect(m.get('lig_webhooks_total{outcome="unknown_source",source="unknown"}')).toBe(1);
    expect(text).not.toContain('source="nope"');
    expect(m.get('lig_webhook_duration_seconds_count{outcome="accepted",source="form"}')).toBe(1);
    expect(m.get('lig_webhook_duration_seconds_bucket{le="+Inf",outcome="accepted",source="form"}')).toBe(1);
    expect(m.get('lig_webhook_duration_seconds_sum{outcome="accepted",source="form"}')).toBeGreaterThan(0);
    expect(text).toContain('# TYPE lig_webhook_duration_seconds histogram');
  });

  it('reads the queue, attempts, dead-letter, duplicates and AI cost from the database', async () => {
    await send('form', lead(1), { eventId: 'e1' });
    await send('form', lead(1), { eventId: 'e1' });
    await db.pool.query(`
      insert into jobs (kind, status, attempts, replays) values
        ('deliver_crm', 'dead', 10, 1), ('deliver_crm', 'done', 3, 0), ('deliver_crm', 'pending', 2, 0), ('classify', 'done', 1, 0)`);
    const leadId = await aLead();
    await db.pool.query(`
      insert into ai_calls (lead_id, purpose, attempt, ai_mode, model, input_tokens, output_tokens, cost_usd, stop_reason, outcome)
      select $1, p, 1, 'recorded', 'claude-haiku-5-5', 1000, 100, 0.00015, 'end_turn', 'valid' from unnest(array['classify', 'classify', 'draft']) p`, [leadId]);
    breaker.failure('CRM error 500');
    breaker.failure('CRM error 500'); // threshold 2: open

    const { m } = await scrape();
    expect(m.get('lig_database_up')).toBe(1);
    expect(m.get('lig_jobs{kind="deliver_crm",status="dead"}')).toBe(1);
    expect(m.get('lig_jobs{kind="deliver_crm",status="pending"}')).toBe(1);
    expect(m.get('lig_jobs{kind="deliver_crm",status="running"}')).toBe(0);
    expect(m.get('lig_jobs{kind="process",status="pending"}')).toBe(1); // queued by the webhook
    // dead 10 + done 3-1 + pending 2 = 14 failed attempts
    expect(m.get('lig_job_failed_attempts{kind="deliver_crm"}')).toBe(14);
    expect(m.get('lig_job_failed_attempts{kind="classify"}')).toBe(0);
    expect(m.get('lig_job_replays{kind="deliver_crm"}')).toBe(1);
    expect(m.get('lig_inbox_webhooks{source="form"}')).toBe(1);
    expect(m.get('lig_inbox_resends{source="form"}')).toBe(1);
    expect(m.get('lig_ai_calls{mode="recorded",outcome="valid",purpose="classify"}')).toBe(2);
    expect(m.get('lig_ai_tokens{direction="input",mode="recorded",purpose="classify"}')).toBe(2000);
    expect(m.get('lig_ai_tokens{direction="output",mode="recorded",purpose="draft"}')).toBe(100);
    expect(m.get('lig_ai_cost_usd{mode="recorded",purpose="classify"}')).toBeCloseTo(0.0003, 10);
    expect(m.get('lig_circuit_breaker_state{destination="fake-crm",state="open"}')).toBe(1);
    expect(m.get('lig_circuit_breaker_state{destination="fake-crm",state="closed"}')).toBe(0);
    expect(m.get('lig_circuit_breaker_consecutive_failures{destination="fake-crm"}')).toBe(2);
  });

  it('a second scrape does not double what is read from the database', async () => {
    await send('form', lead(9));
    await db.pool.query(`insert into ai_calls (lead_id, purpose, attempt, ai_mode, model, input_tokens, output_tokens, cost_usd, stop_reason, outcome)
                         values ($1, 'classify', 1, 'live', 'claude-haiku-5-5', 500, 50, 0.000075, 'end_turn', 'valid')`, [await aLead()]);
    await scrape();
    const { m } = await scrape();
    expect(m.get('lig_ai_tokens{direction="input",mode="live",purpose="classify"}')).toBe(500);
  });

  it('still answers with the database down, and says so', async () => {
    const dead = createPool('postgres://nobody@127.0.0.1:1/none', silentLog);
    const lonely = buildApp({ pool: dead, log: silentLog, gateway });
    const res = await lonely.inject({ method: 'GET', url: '/metrics' });
    await lonely.close();
    await dead.end();
    expect(res.statusCode).toBe(200);
    expect(parse(res.body).get('lig_database_up')).toBe(0);
  });
});
