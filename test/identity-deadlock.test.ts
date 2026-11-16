import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkout } from '../src/db/database.ts';
import { migrate } from '../src/db/migrate.ts';
import { type LeadToStore, resolveIdentity } from '../src/leads/identity.ts';
import { createTestDatabase, type TestDatabase } from './helpers.ts';

/**
 * Two people who share each other's details: A writes with B's phone while B
 * writes with A's phone, at the same moment. Each lead touches both contacts.
 * Whatever order the two transactions lock things in, neither may wait for
 * the other forever (a deadlock, which Postgres breaks by failing one of them).
 */
describe('identity: crossed leads at the same moment', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });
  afterAll(() => db.drop());

  const lead = (n: number, email: string, phone: string): LeadToStore => ({
    inboxId: '0', source: 'form', traceId: `t${n}`, occurredAt: new Date(), name: `Person ${n}`,
    email, phone, emailRaw: email, phoneRaw: phone, message: 'hi', listingRef: null, notes: [],
  });

  async function inTransaction(l: LeadToStore) {
    const { client, release } = await checkout(db.pool);
    try {
      await client.query('begin');
      const { rows } = await client.query<{ id: string }>(`insert into inbox (source, idempotency_key, idempotency_from, headers, body, trace_id) values ('form', $1, 'idempotency-key', '{}', '{}', $1) returning id`, [l.traceId]);
      await resolveIdentity(client, { ...l, inboxId: rows[0].id });
      await client.query('commit');
      return 'ok';
    } catch (err) {
      await client.query('rollback');
      return (err as { code?: string }).code === '40P01' ? 'deadlock' : `error: ${(err as Error).message}`;
    } finally {
      release();
    }
  }

  it('200 crossed pairs: no deadlock, and each pair ends as one contact', async () => {
    const pairs = 200;
    const phone = (n: number) => `+1${['212', '646', '917', '718'][Math.floor(n / 100)]}55501${String(n % 100).padStart(2, '0')}`;
    // A and B exist already, each with an email and a phone.
    for (let i = 0; i < pairs; i++) {
      expect(await inTransaction(lead(4 * i, `a${i}@example.test`, phone(2 * i)))).toBe('ok');
      expect(await inTransaction(lead(4 * i + 1, `b${i}@example.test`, phone(2 * i + 1)))).toBe('ok');
    }
    // Now, per pair, both crossed leads at the same time; 4 pairs at once, so
    // the 8 transactions fit in the pool (10 connections) on a busy machine.
    const outcomes: string[] = [];
    for (let start = 0; start < pairs; start += 4) {
      const batch = Array.from({ length: Math.min(4, pairs - start) }, (_, k) => start + k);
      const results = await Promise.all(
        batch.flatMap((i) => [
          inTransaction(lead(4 * i + 2, `a${i}@example.test`, phone(2 * i + 1))),
          inTransaction(lead(4 * i + 3, `b${i}@example.test`, phone(2 * i))),
        ]),
      );
      outcomes.push(...results);
    }
    const counts = outcomes.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o]: (acc[o] ?? 0) + 1 }), {});
    expect(counts).toEqual({ ok: 2 * pairs });
    const { rows } = await db.pool.query(`select count(*)::int as n from contacts where merged_into is null`);
    expect(rows[0].n).toBe(pairs);
  }, 120_000);
});
