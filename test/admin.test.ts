import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { migrate } from '../src/db/migrate.ts';
import { createTestDatabase, silentLog, testGatewayConfig, type TestDatabase } from './helpers.ts';

const TOKEN = 'test-admin-token-0123456789';

describe('admin endpoints: GET /dead-letter and POST /replay', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    app = buildApp({ pool: db.pool, log: silentLog, gateway: testGatewayConfig(), admin: { token: TOKEN, usingDemoToken: false } });
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('truncate jobs restart identity');
    await db.pool.query(`
      insert into jobs (kind, status, attempts, last_error) values
        ('deliver_crm', 'dead', 10, 'CRM error 500'),
        ('deliver_crm', 'dead', 10, 'CRM unreachable (ECONNREFUSED)'),
        ('classify', 'dead', 10, 'lead not found'),
        ('deliver_crm', 'done', 1, null)`);
  });

  const auth = { authorization: `Bearer ${TOKEN}` };
  const replay = (payload: object, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url: '/replay', headers, payload });
  const statuses = async () => (await db.pool.query('select id::int, status, attempts, replays from jobs order by id')).rows;

  it('refuses without the admin token, or with a wrong one', async () => {
    expect((await app.inject({ method: 'GET', url: '/dead-letter' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/dead-letter', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await replay({ all: true }, { authorization: `Bearer ${TOKEN}x` })).statusCode).toBe(401);
  });

  it('lists the dead jobs with their last error, and can filter by kind', async () => {
    const all = (await app.inject({ method: 'GET', url: '/dead-letter', headers: auth })).json();
    expect(all.count).toBe(3);
    expect(all.jobs.map((j: { last_error: string }) => j.last_error)).toContain('CRM error 500');
    const deliveries = (await app.inject({ method: 'GET', url: '/dead-letter?kind=deliver_crm', headers: auth })).json();
    expect(deliveries.count).toBe(2);
  });

  it('replays the jobs asked for: back to pending, attempts reset, replay counted', async () => {
    const res = await replay({ ids: [1] });
    expect(res.json()).toMatchObject({ replayed: 1 });
    expect((await statuses())[0]).toEqual({ id: 1, status: 'pending', attempts: 0, replays: 1 });
    expect((await statuses())[1].status).toBe('dead');
  });

  it('replays all dead jobs only when asked explicitly, optionally of one kind', async () => {
    expect((await replay({})).statusCode).toBe(400);
    expect((await replay({ all: true, kind: 'deliver_crm' })).json().replayed).toBe(2);
    expect((await replay({ all: true })).json().replayed).toBe(1); // the classify one
  });

  it('never touches a job that is not dead', async () => {
    expect((await replay({ ids: [4] })).json().replayed).toBe(0);
    expect((await statuses())[3]).toMatchObject({ status: 'done', replays: 0 });
  });

  it('refuses ids that are not job ids', async () => {
    expect((await replay({ ids: [] })).statusCode).toBe(400);
    expect((await replay({ ids: ['1; drop table jobs'] })).statusCode).toBe(400);
  });

  it('is not served when the app has no admin config', async () => {
    const bare = buildApp({ pool: db.pool, log: silentLog, gateway: testGatewayConfig() });
    expect((await bare.inject({ method: 'POST', url: '/replay', headers: auth, payload: { all: true } })).statusCode).toBe(404);
    await bare.close();
  });
});
