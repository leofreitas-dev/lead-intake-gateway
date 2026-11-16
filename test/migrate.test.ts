import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.ts';
import { createTestDatabase, type TestDatabase } from './helpers.ts';

describe('migrate', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db.drop());

  it('applies every migration on an empty database', async () => {
    const applied = await migrate(db.pool);
    expect(applied).toContain('001_inbox_and_jobs.sql');
    const tables = await db.pool.query(
      `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(['ai_calls', 'contact_events', 'contact_identifiers', 'contacts', 'crm_sync', 'inbox', 'jobs', 'lead_classifications', 'lead_routes', 'leads', 'reply_drafts', 'schema_migrations']);
  });

  it('does nothing the second time', async () => {
    expect(await migrate(db.pool)).toEqual([]);
  });

  it('applies each migration once even when two processes start together', async () => {
    const other = await createTestDatabase();
    try {
      const [a, b] = await Promise.all([migrate(other.pool), migrate(other.pool)]);
      expect([...a, ...b].filter((f) => f === '001_inbox_and_jobs.sql')).toHaveLength(1);
    } finally {
      await other.drop();
    }
  });

  it('rejects the same webhook twice from the same source (idempotency key)', async () => {
    const insert = `insert into inbox (source, idempotency_key, headers, body, trace_id)
                    values ($1, $2, '{}', '{}', 't1') on conflict (source, idempotency_key) do nothing returning id`;
    const first = await db.pool.query(insert, ['form', 'evt_001']);
    const again = await db.pool.query(insert, ['form', 'evt_001']);
    const otherSource = await db.pool.query(insert, ['whatsapp', 'evt_001']);
    expect(first.rowCount).toBe(1);
    expect(again.rowCount).toBe(0);
    expect(otherSource.rowCount).toBe(1);
  });

  it('gives inbox rows time-ordered ids', async () => {
    const insert = `insert into inbox (source, idempotency_key, headers, body, trace_id)
                    values ('form', $1, '{}', '{}', 't') returning id`;
    const ids: string[] = [];
    for (const key of ['k1', 'k2', 'k3']) ids.push((await db.pool.query(insert, [key])).rows[0].id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('only allows the known job statuses', async () => {
    await expect(
      db.pool.query(`insert into jobs (kind, status) values ('process', 'lost')`),
    ).rejects.toThrow(/jobs_status_check/);
  });
});
