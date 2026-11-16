import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { createPool } from '../src/db/database.ts';
import { createTestDatabase, silentLog, type TestDatabase } from './helpers.ts';

describe('health and readiness', () => {
  let db: TestDatabase;
  let app: App;
  beforeAll(async () => {
    db = await createTestDatabase();
    app = buildApp({ pool: db.pool, log: silentLog });
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it('/health answers without touching the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('/ready says the database is ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', db: 'ok' });
  });

  it('/ready answers 503 quickly when the database is down', async () => {
    // Nothing listens on port 1, so every connection attempt fails.
    const deadPool = createPool('postgres://postgres:x@127.0.0.1:1/none', silentLog);
    const deadApp = buildApp({ pool: deadPool, log: silentLog });
    try {
      const started = Date.now();
      const res = await deadApp.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'not_ready', db: 'down' });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await deadApp.close();
      await deadPool.end();
    }
  });

  it('sends back a new trace id on every request', async () => {
    const a = await app.inject({ method: 'GET', url: '/health' });
    const b = await app.inject({ method: 'GET', url: '/health' });
    expect(a.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('keeps the trace id the caller sent', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'trace-from-n8n-42' } });
    expect(res.headers['x-request-id']).toBe('trace-from-n8n-42');
  });

  it('replaces a trace id with odd characters or an absurd length', async () => {
    for (const bad of ['has spaces', 'x'.repeat(101), '<script>']) {
      const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': bad } });
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
