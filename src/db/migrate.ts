import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

// Any fixed number works; it only has to be the same for every process of this app.
const MIGRATION_LOCK_ID = 7_316_204;

/**
 * Applies every `migrations/*.sql` file that has not run yet, in name order.
 * Each file runs in its own transaction: it applies completely or not at all.
 * An advisory lock makes two processes starting at once wait for each other
 * instead of applying the same file twice.
 * Returns the names of the files applied by this call.
 */
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
  return applied;
}
