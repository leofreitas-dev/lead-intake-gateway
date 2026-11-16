import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.ts';
import { storeWebhook } from '../src/gateway/inbox.ts';
import { processLead } from '../src/leads/process.ts';
import { drain } from '../src/queue/worker.ts';
import { createTestDatabase, silentLog, type TestDatabase } from './helpers.ts';

const run = promisify(execFile);

/**
 * Many leads of the same people, arriving at once and worked by several OS
 * processes (each with its own connection pool and 4 loops), like several
 * gateway instances. Whatever the order, the contacts must come out exactly as
 * the identifiers link them: one contact per group of linked identifiers.
 */

interface FormLead { name: string; email?: string; phone?: string }

/** Small seeded random generator, so a failing round can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AREAS = ['212', '646', '917', '718', '347'];
/** Fictional phones only: 555-0100 to 555-0199 in a few US area codes. */
const phone = (n: number) => ({ raw: `(${AREAS[Math.floor(n / 100)]}) 555-01${String(n % 100).padStart(2, '0')}`, e164: `+1${AREAS[Math.floor(n / 100)]}55501${String(n % 100).padStart(2, '0')}` });
const email = (n: number) => `person${n}@example.test`;

/** The leads of one round, and how many contacts they must make. */
function scenario(seed: number) {
  const random = rng(seed);
  const leads: (FormLead & { keys: string[] })[] = [];
  const add = (name: string, e?: number, p?: number) => {
    const l: FormLead & { keys: string[] } = { name, keys: [] };
    if (e !== undefined) { l.email = email(e); l.keys.push(`e:${e}`); }
    if (p !== undefined) { l.phone = phone(p).raw; l.keys.push(`p:${phone(p).e164}`); }
    leads.push(l);
  };
  let nextEmail = 0;
  let nextPhone = 0;

  // 25 people who write many times: by email only, by phone only, or both.
  for (let i = 0; i < 25; i++) {
    const e = nextEmail++;
    const p = nextPhone++;
    add(`Person ${i}`, e, p); // at least one lead links the two
    for (let k = 0; k < 6; k++) {
      const r = random();
      if (r < 0.33) add(`Person ${i}`, e);
      else if (r < 0.66) add(`P${i}`, undefined, p);
      else add(`Person ${i}`, e, p);
    }
  }
  // 15 crossed pairs: A writes with B's phone and B with A's (a shared family
  // phone, say). Both leads arrive together; this is the shape that can make
  // two transactions wait for each other.
  for (let i = 0; i < 15; i++) {
    const [eA, pA, eB, pB] = [nextEmail++, nextPhone++, nextEmail++, nextPhone++];
    add(`Pair ${i} A`, eA, pB);
    add(`Pair ${i} B`, eB, pA);
    add(`Pair ${i} A`, eA, pA);
    add(`Pair ${i} B`, eB, pB);
  }
  // 5 chains: e0-p0, p0-e1, e1-p1, ... one person across 8 identifiers.
  for (let i = 0; i < 5; i++) {
    const es = [nextEmail++, nextEmail++, nextEmail++, nextEmail++];
    const ps = [nextPhone++, nextPhone++, nextPhone++, nextPhone++];
    for (let k = 0; k < 4; k++) {
      add(`Chain ${i}`, es[k], ps[k]);
      if (k < 3) add(`Chain ${i}`, es[k + 1], ps[k]);
    }
  }
  // 10 people with the same name and different identifiers: never merged.
  for (let i = 0; i < 10; i++) add('Alex Morgan', nextEmail++, nextPhone++);

  // Shuffle the arrival order.
  for (let i = leads.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [leads[i], leads[j]] = [leads[j], leads[i]];
  }

  // Expected contacts: groups of identifiers linked by some lead (union-find).
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    if (!parent.has(k)) parent.set(k, k);
    const p = parent.get(k)!;
    if (p === k) return k;
    const root = find(p);
    parent.set(k, root);
    return root;
  };
  for (const l of leads) for (const k of l.keys.slice(1)) parent.set(find(k), find(l.keys[0]));
  const groupOf = (k: string) => find(k);
  const groups = new Set(leads.map((l) => groupOf(l.keys[0])));
  return { leads, groupOf, expectedContacts: groups.size };
}

describe('identity under stress: many workers in several processes', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });
  afterAll(() => db.drop());

  for (const seed of [1, 2, 3]) {
    it(`round ${seed}: every group of linked identifiers is exactly one contact, with no failed job`, async () => {
      await db.pool.query('truncate contact_events, leads, contact_identifiers, contacts, jobs, inbox cascade');
      const { leads, groupOf, expectedContacts } = scenario(seed);

      // All leads land in the queue first, then everyone starts at once.
      await Promise.all(
        leads.map((l, i) =>
          storeWebhook(db.pool, {
            source: 'form',
            idempotency: { key: `key:stress-${seed}-${i}`, from: 'idempotency-key' },
            headers: {},
            rawBody: JSON.stringify({ name: l.name, email: l.email, phone: l.phone, message: 'Stress test lead.', submitted_at: new Date(Date.UTC(2026, 10, 16, 12, 0, i)).toISOString() }),
            traceId: `stress-${seed}-${i}`,
            remoteAddr: '127.0.0.1',
            parseError: undefined,
          }),
        ),
      );
      // Start gate: hold an advisory lock; the 3 processes wait on it, and all
      // start when it is released (Node takes a while to boot each one).
      const GATE = String(424_242 + seed);
      const gate = await db.pool.connect();
      await gate.query('select pg_advisory_lock($1)', [GATE]);
      const processes = Array.from({ length: 3 }, () => run(process.execPath, ['test/support/drain-process.ts', db.url, '4', GATE]));
      for (let i = 0; i < 300; i++) {
        const { rows } = await db.pool.query(`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1::bigint and not granted`, [GATE]);
        if (rows[0].n === 3) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await gate.query('select pg_advisory_unlock($1)', [GATE]);
      gate.release();
      const inProcess = drain({ pool: db.pool, log: silentLog, kind: 'process', handler: processLead, concurrency: 4, backoff: () => 20 });
      const results = [await inProcess, ...(await Promise.all(processes)).map((r) => JSON.parse(r.stdout.trim().split('\n').pop()!))];
      // A job retried after the others stopped would still be pending: finish it.
      for (let i = 0; i < 100; i++) {
        const { rows } = await db.pool.query(`select count(*)::int as n from jobs where kind = 'process' and status <> 'done'`);
        if (rows[0].n === 0) break;
        await new Promise((r) => setTimeout(r, 50));
        results.push(await drain({ pool: db.pool, log: silentLog, kind: 'process', handler: processLead, concurrency: 1, backoff: () => 20 }));
      }
      expect(results.every((r) => r.done > 0), 'every process took part').toBe(true);

      const q = async (sql: string) => (await db.pool.query(sql)).rows;
      // Every lead stored once, every job done, and none had to be retried.
      expect(await q(`select count(*)::int as n from leads`)).toEqual([{ n: leads.length }]);
      // (a done job had attempts = 1; more means it failed first, e.g. a deadlock)
      const retries = results.reduce((n, r) => n + r.retry + r.dead, 0);
      expect(await q(`select id, status, attempts, last_error from jobs where kind = 'process' and (status <> 'done' or attempts > 1)`)).toEqual([]);
      expect(retries).toBe(0);

      // Exactly one active contact per group.
      expect(await q(`select count(*)::int as n from contacts where merged_into is null`)).toEqual([{ n: expectedContacts }]);

      // Every identifier belongs to an active contact, and each group's identifiers to the same one.
      const ids = await q(`select i.kind, i.value, i.contact_id, c.merged_into from contact_identifiers i join contacts c on c.id = i.contact_id`);
      expect(ids.filter((r) => r.merged_into !== null)).toEqual([]);
      const contactOfGroup = new Map<string, string>();
      for (const r of ids) {
        const key = r.kind === 'email' ? `e:${Number(/person(\d+)@/.exec(r.value)![1])}` : `p:${r.value}`;
        const g = groupOf(key);
        if (!contactOfGroup.has(g)) contactOfGroup.set(g, r.contact_id);
        expect(r.contact_id, `group of ${key}`).toBe(contactOfGroup.get(g));
      }
      expect(new Set(contactOfGroup.values()).size).toBe(expectedContacts);

      // Every lead points to an active contact; each merge left exactly one "merged" event.
      expect(await q(`select l.id from leads l join contacts c on c.id = l.contact_id where c.merged_into is not null`)).toEqual([]);
      const [{ absorbed }] = await q(`select count(*)::int as absorbed from contacts where merged_into is not null`);
      expect(await q(`select count(*)::int as n from contact_events where kind = 'merged'`)).toEqual([{ n: absorbed }]);
    }, 120_000);
  }
});
