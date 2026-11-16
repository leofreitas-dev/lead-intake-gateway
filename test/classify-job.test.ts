import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Classifier, ModelReply } from '../src/ai/classifier.ts';
import { loadPriceList } from '../src/ai/pricing.ts';
import { migrate } from '../src/db/migrate.ts';
import { storeWebhook } from '../src/gateway/inbox.ts';
import { CLASSIFY_JOB, makeClassifyHandler } from '../src/leads/classify-job.ts';
import { processLead } from '../src/leads/process.ts';
import { drain } from '../src/queue/worker.ts';
import { createTestDatabase, silentLog, type TestDatabase } from './helpers.ts';

const good = { intent: 'buy', urgency: 'high', budget_band: 'buy_500k_to_1m', language: 'en', confidence: 0.93, evidence: 'Saturday viewing.' };

/** A fake model, no network: answers each call with the next reply in the list. */
function fakeAi(replies: (Partial<ModelReply> | Error)[]): Classifier & { calls: number } {
  return {
    mode: 'live',
    model: 'claude-haiku-5-5',
    calls: 0,
    async complete() {
      const r = replies[Math.min(this.calls++, replies.length - 1)];
      if (r instanceof Error) throw r;
      return { text: null, stopReason: 'end_turn', model: 'claude-haiku-5-5', inputTokens: 420, outputTokens: 64, ...r };
    },
  };
}

describe('the classify job', () => {
  let db: TestDatabase;
  const prices = loadPriceList();
  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });
  afterAll(() => db.drop());
  beforeEach(async () => {
    await db.pool.query('truncate ai_calls, lead_classifications, lead_routes, contact_events, leads, contact_identifiers, contacts, jobs, inbox cascade');
  });

  /** A lead arrives and is processed (identity), exactly as in production. */
  async function leadArrives(message = 'Can we see the 3-bedroom this Saturday? Budget $650k.') {
    await storeWebhook(db.pool, {
      source: 'form',
      idempotency: { key: `key:${randomUUID()}`, from: 'idempotency-key' },
      headers: {},
      rawBody: JSON.stringify({ name: 'Emily Carter', email: 'emily.carter@example.test', phone: '(212) 555-0147', message }),
      traceId: 'trace-classify-test',
      remoteAddr: '127.0.0.1',
      parseError: undefined,
    });
    await drain({ pool: db.pool, log: silentLog, kind: 'process', handler: processLead });
    return (await db.pool.query('select id from leads')).rows[0].id as string;
  }
  const classify = (ai: Classifier) =>
    drain({ pool: db.pool, log: silentLog, kind: CLASSIFY_JOB, handler: makeClassifyHandler({ classifier: ai, prices }), backoff: () => 60_000 });
  const one = async (sql: string) => (await db.pool.query(sql)).rows[0];

  it('processing a lead queues its classify job, with the trace id, in the same transaction', async () => {
    const leadId = await leadArrives();
    expect(await one(`select kind, payload, trace_id, status from jobs where kind = 'classify'`)).toEqual({
      kind: 'classify', payload: { lead_id: leadId }, trace_id: 'trace-classify-test', status: 'pending',
    });
  });

  it('stores what the AI said, every call with tokens and cost, the route with its reason, and a timeline event', async () => {
    const leadId = await leadArrives();
    expect(await classify(fakeAi([{ text: JSON.stringify(good) }]))).toMatchObject({ done: 1, retry: 0 });

    expect(await one('select status, intent, urgency, budget_band, language, confidence::float, review_reason, input_tokens, output_tokens, cost_usd::float from lead_classifications')).toEqual({
      status: 'classified', intent: 'buy', urgency: 'high', budget_band: 'buy_500k_to_1m', language: 'en', confidence: 0.93,
      review_reason: null, input_tokens: 420, output_tokens: 64, cost_usd: (420 * 0.1 + 64 * 0.5) / 1e6,
    });
    expect((await db.pool.query('select attempt, outcome, ai_mode from ai_calls')).rows).toEqual([{ attempt: 1, outcome: 'valid', ai_mode: 'live' }]);
    expect(await one('select lead_id, route, rule, reason from lead_routes')).toEqual({
      lead_id: leadId, route: 'on_call_agent', rule: 'urgent-buyer-or-seller', reason: 'wants to buy and urgency is high: the on-call agent calls back within 15 minutes',
    });
    expect(await one(`select kind, detail->>'route' as route from contact_events where kind = 'routed'`)).toEqual({ kind: 'routed', route: 'on_call_agent' });
  });

  it('invalid twice → manual review, both paid calls recorded', async () => {
    await leadArrives();
    await classify(fakeAi([{ text: 'buy, high' }, { text: '{"intent": "buy"}' }]));
    expect(await one('select status, intent, review_reason from lead_classifications')).toMatchObject({ status: 'needs_review', intent: null });
    expect((await one('select review_reason from lead_classifications')).review_reason).toMatch(/invalid 2 times/);
    expect((await db.pool.query('select outcome from ai_calls order by attempt')).rows.map((r) => r.outcome)).toEqual(['invalid', 'invalid']);
    expect(await one('select route, rule from lead_routes')).toEqual({ route: 'manual_review', rule: 'needs-review' });
  });

  it('an API error writes nothing and the job is retried later (no lead routed without an answer)', async () => {
    await leadArrives();
    expect(await classify(fakeAi([new Error('529 overloaded')]))).toMatchObject({ done: 0, retry: 1 });
    expect(await one(`select status, attempts, last_error from jobs where kind = 'classify'`)).toEqual({ status: 'pending', attempts: 1, last_error: '529 overloaded' });
    expect((await one('select count(*)::int as n from ai_calls')).n).toBe(0);
    expect((await one('select count(*)::int as n from lead_routes')).n).toBe(0);
  });

  it('a classify job that runs again does not call the AI twice nor duplicate anything', async () => {
    const leadId = await leadArrives();
    const ai = fakeAi([{ text: JSON.stringify(good) }]);
    await classify(ai);
    await db.pool.query(`insert into jobs (kind, payload) values ('classify', $1)`, [{ lead_id: leadId }]);
    await classify(ai);
    expect(ai.calls).toBe(1);
    expect((await one('select count(*)::int as n from ai_calls')).n).toBe(1);
  });
});
