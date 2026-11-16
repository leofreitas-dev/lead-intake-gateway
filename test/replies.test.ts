import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Classifier, ModelReply } from '../src/ai/classifier.ts';
import type { Drafter } from '../src/ai/draft.ts';
import { loadPriceList } from '../src/ai/pricing.ts';
import { migrate } from '../src/db/migrate.ts';
import { storeWebhook } from '../src/gateway/inbox.ts';
import { CLASSIFY_JOB, makeClassifyHandler } from '../src/leads/classify-job.ts';
import { processLead } from '../src/leads/process.ts';
import { drain } from '../src/queue/worker.ts';
import { approveDraft, rejectDraft } from '../src/replies/decide.ts';
import { DRAFT_JOB, makeDraftHandler } from '../src/replies/draft-job.ts';
import { createTestDatabase, silentLog, type TestDatabase } from './helpers.ts';

const prices = loadPriceList();
const buyer = { intent: 'buy', urgency: 'high', budget_band: 'buy_500k_to_1m', language: 'en', confidence: 0.93, evidence: 'Saturday viewing.' };
const spam = { ...buyer, intent: 'spam', urgency: 'low', budget_band: 'not_stated', evidence: 'SEO offer.' };
const vendor = { ...spam, intent: 'vendor', evidence: 'Photography services.' };
const reply = 'Hi {first_name}, thank you for your message. One of our agents will contact you shortly to confirm the details. Juniper Lane Realty';

function model(answer: (n: number) => string | null): Classifier & Drafter & { calls: number } {
  return {
    mode: 'live',
    model: 'claude-haiku-5-5',
    calls: 0,
    async complete(): Promise<ModelReply> {
      return { text: answer(this.calls++), stopReason: 'end_turn', model: 'claude-haiku-5-5', inputTokens: 300, outputTokens: 60 };
    },
  };
}
const draftOf = (body: string) => JSON.stringify({ language: 'en', body });

describe('reply drafts: from a classified lead to the outbox', () => {
  let db: TestDatabase;
  let outbox: string;
  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });
  afterAll(() => db.drop());
  beforeEach(async () => {
    await db.pool.query('truncate reply_drafts, ai_calls, lead_classifications, lead_routes, contact_events, leads, contact_identifiers, contacts, jobs, inbox cascade');
    outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lig-outbox-'));
  });

  let clock = Date.parse('2026-11-16T12:00:00Z');
  /** A lead arrives, is processed and classified with the given answer. */
  async function lead(classification: object, person = { name: 'Emily Carter', email: 'emily.carter@example.test', phone: '(212) 555-0147' }) {
    clock += 60_000;
    await storeWebhook(db.pool, {
      source: 'form',
      idempotency: { key: `key:${randomUUID()}`, from: 'idempotency-key' },
      headers: {},
      rawBody: JSON.stringify({ ...person, message: 'Can we see the 3-bedroom this Saturday?', submitted_at: new Date(clock).toISOString() }),
      traceId: 'trace-replies-test',
      remoteAddr: '127.0.0.1',
      parseError: undefined,
    });
    await drain({ pool: db.pool, log: silentLog, kind: 'process', handler: processLead });
    await drain({ pool: db.pool, log: silentLog, kind: CLASSIFY_JOB, handler: makeClassifyHandler({ classifier: model(() => JSON.stringify(classification)), prices }) });
  }
  const draftJobs = async () => (await db.pool.query(`select count(*)::int as n from jobs where kind = $1`, [DRAFT_JOB])).rows[0].n as number;
  const draft = (ai: Drafter) => drain({ pool: db.pool, log: silentLog, kind: DRAFT_JOB, handler: makeDraftHandler({ drafter: ai, prices }), backoff: () => 60_000 });
  const drafts = async () =>
    (await db.pool.query(`select id::text, status, ai_body, language, problems, input_tokens, output_tokens, superseded_by::text from reply_drafts order by id`)).rows;

  it('a buyer gets a draft job; spam and a vendor do not', async () => {
    await lead(buyer);
    expect(await draftJobs()).toBe(1);
    await lead(spam, { name: 'Growth Team', email: 'growth@seo.test', phone: '' });
    await lead(vendor, { name: 'Lens Studio', email: 'hello@lens.test', phone: '' });
    expect(await draftJobs()).toBe(1);
  });

  it('the draft waits for a person, with the first name filled in by code and its AI cost recorded', async () => {
    await lead(buyer);
    expect(await draft(model(() => draftOf(reply)))).toMatchObject({ done: 1 });
    const [d] = await drafts();
    expect(d).toMatchObject({ status: 'pending', language: 'en', input_tokens: 300, output_tokens: 60, problems: [] });
    expect(d.ai_body).toBe(reply.replace('{first_name}', 'Emily'));
    expect((await db.pool.query(`select purpose, outcome from ai_calls where purpose = 'draft'`)).rows).toEqual([{ purpose: 'draft', outcome: 'valid' }]);
  });

  it('a draft that keeps breaking the rules is blocked: a person writes the reply', async () => {
    await lead(buyer);
    const ai = model(() => draftOf('Hi {first_name}, it is still available at $699,000!'));
    await draft(ai);
    expect(ai.calls).toBe(2);
    const [d] = await drafts();
    expect(d.status).toBe('blocked');
    expect(d.ai_body).toBeNull();
    expect(d.problems).toContain('claims availability or inventory the system does not know');
  });

  it('the same person writing twice gets one reply: the newer lead\'s draft replaces the older one', async () => {
    await lead(buyer);
    await lead(buyer);
    await draft(model(() => draftOf(reply)));
    const rows = await drafts();
    expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'superseded']);
    const kept = rows.find((r) => r.status === 'pending')!;
    expect(rows.find((r) => r.status === 'superseded')!.superseded_by).toBe(kept.id);
  });

  it('approve writes the reply to the outbox (never sent), once', async () => {
    await lead(buyer);
    await draft(model(() => draftOf(reply)));
    const [d] = await drafts();
    const result = await approveDraft(db.pool, { id: d.id, by: 'admin', outboxDir: outbox });
    expect(result).toEqual({ ok: true, status: 'approved', draftId: d.id, outboxFile: `reply-${d.id}.json` });
    const file = JSON.parse(fs.readFileSync(path.join(outbox, `reply-${d.id}.json`), 'utf8'));
    expect(file).toMatchObject({
      not_sent: expect.stringContaining('not sent'),
      channel: 'form',
      to: { name: 'Emily Carter', email: 'emily.carter@example.test' },
      body: d.ai_body,
      decision: 'approved',
      decided_by: 'admin',
    });
    expect(fs.readdirSync(outbox)).toEqual([`reply-${d.id}.json`]);
    expect(await approveDraft(db.pool, { id: d.id, by: 'admin', outboxDir: outbox })).toEqual({ ok: false, error: 'already_decided', status: 'approved' });
    expect(await rejectDraft(db.pool, { id: d.id, by: 'admin' })).toMatchObject({ ok: false, error: 'already_decided' });
  });

  it('an edited reply is saved as edited, with the text the person wrote', async () => {
    await lead(buyer);
    await draft(model(() => draftOf(reply)));
    const [d] = await drafts();
    expect(await approveDraft(db.pool, { id: d.id, by: 'admin', outboxDir: outbox, body: '  ' })).toEqual({ ok: false, error: 'empty_reply' });
    expect(fs.readdirSync(outbox)).toEqual([]);
    const edited = 'Hi Emily, thanks! Our agent will call you today.';
    expect(await approveDraft(db.pool, { id: d.id, by: 'admin', outboxDir: outbox, body: edited })).toMatchObject({ ok: true, status: 'edited' });
    expect((await db.pool.query('select status, final_body from reply_drafts')).rows[0]).toEqual({ status: 'edited', final_body: edited });
    expect(JSON.parse(fs.readFileSync(path.join(outbox, `reply-${d.id}.json`), 'utf8')).body).toBe(edited);
  });

  it('a blocked draft can be written by hand and approved', async () => {
    await lead(buyer);
    await draft(model(() => draftOf('Hi {first_name}, it is still available at $699,000!')));
    const [d] = await drafts();
    expect(await approveDraft(db.pool, { id: d.id, by: 'admin', outboxDir: outbox })).toEqual({ ok: false, error: 'empty_reply' });
    expect(await approveDraft(db.pool, { id: d.id, by: 'admin', outboxDir: outbox, body: 'Hi Emily, thank you. An agent will contact you.' })).toMatchObject({ ok: true, status: 'edited' });
  });

  it('reject: nothing reaches the outbox, the reason and the decision are on the timeline', async () => {
    await lead(buyer);
    await draft(model(() => draftOf(reply)));
    const [d] = await drafts();
    expect(await rejectDraft(db.pool, { id: d.id, by: 'admin', reason: 'already called her' })).toEqual({ ok: true, status: 'rejected', draftId: d.id, outboxFile: null });
    expect(fs.readdirSync(outbox)).toEqual([]);
    expect((await db.pool.query('select status, reject_reason from reply_drafts')).rows[0]).toEqual({ status: 'rejected', reject_reason: 'already called her' });
    expect((await db.pool.query(`select detail->>'status' as status from contact_events where kind = 'reply' order by id`)).rows).toEqual([
      { status: 'drafted' }, { status: 'rejected' },
    ]);
  });

  it('two people approving at the same moment: one wins, one file', async () => {
    await lead(buyer);
    await draft(model(() => draftOf(reply)));
    const [d] = await drafts();
    const results = await Promise.all([
      approveDraft(db.pool, { id: d.id, by: 'a', outboxDir: outbox }),
      approveDraft(db.pool, { id: d.id, by: 'b', outboxDir: outbox, body: 'Hi Emily, edited.' }),
      rejectDraft(db.pool, { id: d.id, by: 'c' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(fs.readdirSync(outbox).length).toBeLessThanOrEqual(1);
  });

  it('an unknown or malformed id is not found', async () => {
    expect(await approveDraft(db.pool, { id: '999', by: 'admin', outboxDir: outbox })).toEqual({ ok: false, error: 'not_found' });
    expect(await rejectDraft(db.pool, { id: 'x; drop table', by: 'admin' })).toEqual({ ok: false, error: 'not_found' });
  });
});
