import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { GatewayConfig } from '../src/config.ts';
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

/** Gateway settings for tests: known secrets, a 5-minute window, a rate limit too high to get in the way. */
export function testGatewayConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    secrets: {
      form: 'test-secret-form-0123456789',
      email: 'test-secret-email-0123456789',
      whatsapp: 'test-secret-whatsapp-0123456789',
      portal: 'test-secret-portal-0123456789',
    },
    usingDemoSecrets: false,
    signatureToleranceSec: 300,
    rateLimitPerSec: 1000,
    rateLimitBurst: 1000,
    bodyLimitBytes: 64 * 1024,
    ...overrides,
  };
}

/** Waits until `check` is true, instead of guessing how long something takes. */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
