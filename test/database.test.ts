import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.ts';
import { silentLog } from './helpers.ts';

// Starts its own embedded Postgres (also in CI) to prove the zero-install path works.
describe('openDatabase without DATABASE_URL', () => {
  let dataDir: string;
  const config = () => ({ databaseUrl: undefined, dataDir, embeddedPgPort: 54332 });

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lead-intake-db-'));
  });
  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('starts a real Postgres 18 and keeps the data after a restart', async () => {
    const first = await openDatabase(config(), silentLog);
    expect(first.embedded).toBe(true);
    const version = await first.pool.query<{ server_version_num: string }>('show server_version_num');
    expect(Number(version.rows[0].server_version_num)).toBeGreaterThanOrEqual(180000);
    await first.pool.query('create table notes (text text)');
    await first.pool.query(`insert into notes values ('still here')`);
    await first.close();

    const second = await openDatabase(config(), silentLog);
    const rows = await second.pool.query('select text from notes');
    expect(rows.rows).toEqual([{ text: 'still here' }]);
    await second.close();
  });
});
