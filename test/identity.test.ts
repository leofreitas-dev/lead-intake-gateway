import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.ts';
import { storeWebhook } from '../src/gateway/inbox.ts';
import { betterName, decide } from '../src/leads/identity.ts';
import { processLead } from '../src/leads/process.ts';
import { drain } from '../src/queue/worker.ts';
import type { Source } from '../src/sources.ts';
import { createTestDatabase, silentLog, type TestDatabase } from './helpers.ts';

describe('decide (the matching rules)', () => {
  const older = { contactId: 'A', createdAt: new Date('2026-01-01') };
  const newer = { contactId: 'B', createdAt: new Date('2026-02-01') };

  it('no email or phone match: new contact', () => {
    expect(decide(undefined, undefined)).toEqual({ action: 'create' });
  });

  it('same email: same person', () => {
    expect(decide(older, undefined)).toEqual({ action: 'attach', contactId: 'A', matchedBy: ['email'] });
  });

  it('same phone: same person', () => {
    expect(decide(undefined, older)).toEqual({ action: 'attach', contactId: 'A', matchedBy: ['phone'] });
  });

  it('email and phone of the same contact', () => {
    expect(decide(older, older)).toEqual({ action: 'attach', contactId: 'A', matchedBy: ['email', 'phone'] });
  });

  it('email of one contact and phone of another: merge, the older one survives', () => {
    expect(decide(newer, older)).toEqual({ action: 'merge', keep: 'A', absorb: 'B', matchedBy: ['email', 'phone'] });
    expect(decide(older, newer)).toEqual({ action: 'merge', keep: 'A', absorb: 'B', matchedBy: ['email', 'phone'] });
  });
});

describe('betterName', () => {
  it('keeps the more complete name', () => {
    expect(betterName('Dan B', 'Daniel Brooks')).toBe('Daniel Brooks');
    expect(betterName('Daniel Brooks', 'Dan')).toBe('Daniel Brooks');
    expect(betterName('Emily C', 'Emily Carter')).toBe('Emily Carter');
    expect(betterName(null, 'Marcus')).toBe('Marcus');
    expect(betterName('Marcus', null)).toBe('Marcus');
  });
});

describe('processing leads into contacts', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });
  afterAll(() => db.drop());
  beforeEach(async () => {
    await db.pool.query('truncate contact_events, leads, contact_identifiers, contacts, jobs, inbox cascade');
  });

  /** Stores a webhook (as the gateway would) with its "process" job. */
  const receive = (source: Source, body: object) =>
    storeWebhook(db.pool, {
      source,
      idempotency: { key: `key:${randomUUID()}`, from: 'idempotency-key' },
      headers: {},
      rawBody: JSON.stringify(body),
      traceId: randomUUID(),
      remoteAddr: '127.0.0.1',
      parseError: undefined,
    });
  const processAll = (concurrency = 4) => drain({ pool: db.pool, log: silentLog, kind: 'process', handler: processLead, concurrency });

  const activeContacts = async () =>
    (await db.pool.query(`
      select c.id, c.display_name,
             (select array_agg(kind || ':' || value order by kind) from contact_identifiers i where i.contact_id = c.id) as identifiers,
             (select count(*)::int from leads l where l.contact_id = c.id) as leads
        from contacts c where c.merged_into is null order by c.created_at`)).rows;
  const timeline = async (contactId: string) =>
    (await db.pool.query(
      `select kind, detail from contact_events where contact_id = $1 order by occurred_at, id`,
      [contactId],
    )).rows;

  it('the same person by form, WhatsApp and portal, phone written 3 ways: 1 contact, 3 leads', async () => {
    await receive('form', { name: 'Emily Carter', email: 'Emily.Carter@example.test', phone: '(212) 555-0147', submitted_at: '2026-11-16T10:02:00-05:00' });
    await processAll();
    await receive('whatsapp', { from: '12125550147', profile_name: 'Emily C', text: 'Still available?', timestamp: '1794842100' });
    await processAll();
    await receive('portal', { lead: { first_name: 'Emily', last_name: 'Carter', email: ' emily.carter@example.test', phone: '+1 212.555.0147' }, created_at: '2026-11-16T11:40:00-05:00' });
    await processAll();

    const contacts = await activeContacts();
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      display_name: 'Emily Carter',
      identifiers: ['email:emily.carter@example.test', 'phone:+12125550147'],
      leads: 3,
    });
    const events = await timeline(contacts[0].id);
    expect(events.map((e) => [e.kind, e.detail.source, e.detail.matched_by])).toEqual([
      ['lead', 'form', []],
      ['lead', 'whatsapp', ['phone']],
      ['lead', 'portal', ['email', 'phone']],
    ]);
  });

  it('the same name with a different email and phone: two people', async () => {
    await receive('form', { name: 'Emily Carter', email: 'emily.carter@example.test', phone: '(212) 555-0147' });
    await receive('form', { name: 'Emily Carter', email: 'e.carter.nyc@example.test', phone: '(646) 555-0110' });
    await processAll();
    expect(await activeContacts()).toHaveLength(2);
  });

  it('a name alone never matches, even with nothing else to go on', async () => {
    await receive('form', { name: 'Best SEO Services', message: 'Rank #1!' });
    await receive('form', { name: 'Best SEO Services', message: 'Rank #1!!' });
    await processAll();
    const contacts = await activeContacts();
    expect(contacts).toHaveLength(2);
    expect(contacts.every((c) => c.identifiers === null)).toBe(true);
  });

  it('a lead with only a phone', async () => {
    await receive('whatsapp', { from: '13055550182', profile_name: 'Marcus', text: 'Hi' });
    await processAll();
    expect(await activeContacts()).toMatchObject([{ display_name: 'Marcus', identifiers: ['phone:+13055550182'], leads: 1 }]);
  });

  it('a known phone with a new email: the email is added and shows on the timeline', async () => {
    await receive('whatsapp', { from: '13055550182', profile_name: 'Marcus', text: 'Hi' });
    await processAll();
    await receive('form', { name: 'Marcus Lee', email: 'marcus.lee@example.test', phone: '305-555-0182' });
    await processAll();
    const [contact] = await activeContacts();
    expect(contact).toMatchObject({ display_name: 'Marcus Lee', identifiers: ['email:marcus.lee@example.test', 'phone:+13055550182'], leads: 2 });
    expect((await timeline(contact.id)).map((e) => e.kind)).toEqual(['lead', 'lead', 'identifier_added']);
  });

  it('a lead that links two contacts merges them and says why', async () => {
    await receive('form', { name: 'Daniel Brooks', email: 'daniel.brooks@example.test', submitted_at: '2026-11-16T09:00:00Z' });
    await processAll();
    await receive('whatsapp', { from: '19175550121', profile_name: 'Dan B', text: 'Hi', timestamp: '1794826800' });
    await processAll();
    expect(await activeContacts()).toHaveLength(2);
    const [older, newer] = await activeContacts();

    await receive('portal', { lead: { first_name: 'Daniel', last_name: 'Brooks', email: 'daniel.brooks@example.test', phone: '(917) 555-0121' }, created_at: '2026-11-16T12:00:00Z' });
    await processAll();

    const contacts = await activeContacts();
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      id: older.id,
      display_name: 'Daniel Brooks',
      identifiers: ['email:daniel.brooks@example.test', 'phone:+19175550121'],
      leads: 3,
    });
    const absorbed = await db.pool.query('select merged_into from contacts where id = $1', [newer.id]);
    expect(absorbed.rows[0].merged_into).toBe(older.id);

    const events = await timeline(older.id);
    expect(events.map((e) => e.kind)).toEqual(['lead', 'lead', 'lead', 'merged']);
    expect(events[3].detail).toMatchObject({ absorbed_contact: newer.id, absorbed_name: 'Dan B' });
    expect(events[3].detail.reason).toMatch(/email daniel\.brooks@example\.test.*phone \+19175550121/);
  });

  it('keeps notes about what could not be used', async () => {
    await receive('form', { name: 'Olivia', email: 'olivia@', phone: '555-01' });
    await processAll();
    const { rows } = await db.pool.query('select email, phone, email_raw, phone_raw, notes from leads');
    expect(rows[0]).toMatchObject({ email: null, phone: null, email_raw: 'olivia@', phone_raw: '555-01' });
    expect(rows[0].notes).toHaveLength(2);
  });

  it('many leads of one person processed at the same moment: still 1 contact', async () => {
    const phones = ['(212) 555-0147', '212.555.0147', '+1 212 555 0147', '2125550147', '1-212-555-0147'];
    for (let i = 0; i < 20; i++) {
      if (i % 2) await receive('whatsapp', { from: '12125550147', profile_name: 'Emily', text: `message ${i}` });
      else await receive('form', { name: 'Emily Carter', email: 'emily.carter@example.test', phone: phones[i % phones.length], message: `message ${i}` });
    }
    const counts = await processAll(8);
    expect(counts.done).toBe(20);
    expect(await activeContacts()).toMatchObject([{ leads: 20 }]);
  });

  it('merges correctly when the linking leads arrive together', async () => {
    // Two separate people so far...
    await receive('form', { name: 'Daniel Brooks', email: 'daniel.brooks@example.test' });
    await receive('whatsapp', { from: '19175550121', profile_name: 'Dan B', text: 'Hi' });
    await processAll(1);
    // ...then several leads with both identifiers, processed in parallel.
    for (let i = 0; i < 6; i++) {
      await receive('portal', { lead: { name: 'Daniel Brooks', email: 'daniel.brooks@example.test', phone: '9175550121', comments: `#${i}` } });
    }
    expect((await processAll(6)).done).toBe(6);
    expect(await activeContacts()).toMatchObject([{ leads: 8 }]);
    const merges = await db.pool.query(`select count(*)::int as n from contact_events where kind = 'merged'`);
    expect(merges.rows[0].n).toBe(1);
  });
});
