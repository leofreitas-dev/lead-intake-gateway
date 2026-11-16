import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createPool } from '../src/db/database.ts';
import { createLogger } from '../src/logger.ts';

export const silentLog = createLogger({ logLevel: 'silent', logPretty: false });

export interface TestDatabase {
  pool: pg.Pool;
  url: string;
  drop(): Promise<void>;
}

/** A fresh, empty database for one test file, so tests never see each other's rows. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject('adminDatabaseUrl');
  const name = `test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), silentLog);

  return {
    pool,
    url: url.toString(),
    drop: async () => {
      await pool.end();
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.query(`drop database if exists ${name} with (force)`);
      await client.end();
    },
  };
}
