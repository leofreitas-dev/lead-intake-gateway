import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.ts';
import { backoffMs } from '../src/queue/backoff.ts';
import { drain, type ExternalJobHandler, type JobHandler, runOneJob, runOneLeasedJob, startWorker, WORKER_ID } from '../src/queue/worker.ts';
import { createTestDatabase, silentLog, type TestDatabase } from './helpers.ts';

describe('backoff with jitter', () => {
  it('doubles the ceiling each attempt, up to the maximum', () => {
    const top = (attempt: number) => backoffMs(attempt, { random: () => 1 });
    expect([1, 2, 3, 4, 5].map(top)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(top(30)).toBe(600_000);
  });

  it('picks a random wait between zero and the ceiling', () => {
    expect(backoffMs(3, { random: () => 0 })).toBe(0);
    expect(backoffMs(3, { random: () => 0.5 })).toBe(2_000);
  });
});

describe('job queue', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    await db.pool.query('create table work_log (job_id bigint, note text)');
  });
  afterAll(() => db.drop());
  beforeEach(async () => {
    await db.pool.query('truncate jobs, work_log restart identity');
  });

  const addJobs = (n: number, kind = 'test') =>
    db.pool.query(`insert into jobs (kind, max_attempts) select $1, 3 from generate_series(1, $2)`, [kind, n]);
  const jobs = async () => (await db.pool.query('select id::int, status, attempts, last_error, run_at > now() as later from jobs order by id')).rows;
  const options = (handler: JobHandler, extra = {}) => ({ pool: db.pool, log: silentLog, kind: 'test', handler, backoff: () => 60_000, ...extra });

  it('two workers at the same moment take different jobs (SKIP LOCKED)', async () => {
    await addJobs(2);
    const taken: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: JobHandler = async (_c, job) => {
      taken.push(job.id);
      if (taken.length === 2) release();
      await gate; // both jobs are held at the same time
    };
    const results = await Promise.all([runOneJob(options(slow)), runOneJob(options(slow))]);
    expect(results).toEqual(['done', 'done']);
    expect(new Set(taken).size).toBe(2);
  });

  it('commits the work together with "done"', async () => {
    await addJobs(1);
    await runOneJob(options(async (c, job) => void (await c.query(`insert into work_log values ($1, 'ok')`, [job.id]))));
    expect(await jobs()).toMatchObject([{ status: 'done', attempts: 1 }]);
    expect((await db.pool.query('select * from work_log')).rowCount).toBe(1);
  });

  it('on failure, undoes the work, counts the attempt and schedules a retry', async () => {
    await addJobs(1);
    const failing: JobHandler = async (c, job) => {
      await c.query(`insert into work_log values ($1, 'half done')`, [job.id]);
      throw new Error('boom');
    };
    expect(await runOneJob(options(failing))).toBe('retry');
    expect(await jobs()).toEqual([{ id: 1, status: 'pending', attempts: 1, last_error: 'boom', later: true }]);
    expect((await db.pool.query('select * from work_log')).rowCount).toBe(0);
    // Not ready yet: the retry waits for its backoff.
    expect(await runOneJob(options(failing))).toBe('empty');
  });

  it('after the last attempt, moves the job to dead-letter', async () => {
    await addJobs(1);
    const failing: JobHandler = async () => {
      throw new Error('still broken');
    };
    const now = options(failing, { backoff: () => 0 });
    expect([await runOneJob(now), await runOneJob(now), await runOneJob(now)]).toEqual(['retry', 'retry', 'dead']);
    expect(await jobs()).toMatchObject([{ status: 'dead', attempts: 3, last_error: 'still broken' }]);
    expect(await runOneJob(now)).toBe('empty');
  });

  it('a failing job gets exactly one attempt per round, even with many loops racing for it', async () => {
    // Regression: the failure used to be recorded after the lock was released,
    // so another loop could take the same job again in that gap.
    await addJobs(30);
    const counts = await drain(options(async () => { throw new Error('boom'); }, { concurrency: 8 }));
    expect(counts.retry).toBe(30);
    expect((await jobs()).every((j) => j.attempts === 1 && j.status === 'pending' && j.later)).toBe(true);
  });

  it('an error that says retrying cannot help goes to dead-letter at once', async () => {
    await addJobs(1);
    const refused: JobHandler = async () => { throw Object.assign(new Error('CRM refused the data (422)'), { retryable: false }); };
    expect(await runOneJob(options(refused))).toBe('dead');
    expect(await jobs()).toMatchObject([{ status: 'dead', attempts: 1 }]);
  });

  it('waits at least as long as the other side asked (Retry-After)', async () => {
    await addJobs(1);
    const limited: JobHandler = async () => { throw Object.assign(new Error('429'), { retryAfterMs: 120_000 }); };
    await runOneJob(options(limited, { backoff: () => 10 }));
    const { rows } = await db.pool.query(`select run_at > now() + interval '100 seconds' as far from jobs`);
    expect(rows[0].far).toBe(true);
  });

  it('maxAttempts on the worker overrides the job\'s own limit', async () => {
    await addJobs(1); // max_attempts 3 on the row
    const failing: JobHandler = async () => { throw new Error('x'); };
    expect(await runOneJob(options(failing, { maxAttempts: 1 }))).toBe('dead');
  });

  it('while the gate is closed no job is taken; when it opens, the queue drains', async () => {
    await addJobs(3);
    let open = false;
    setTimeout(() => (open = true), 300);
    const started = Date.now();
    const counts = await drain(options(async () => {}, { gate: { waitMs: () => (open ? 0 : 50) } }));
    expect(counts.done).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('a job interrupted halfway stays pending, with nothing half written', async () => {
    await addJobs(1);
    // Simulates the process dying: the connection drops in the middle of the work.
    const dies: JobHandler = async (c, job) => {
      await c.query(`insert into work_log values ($1, 'half done')`, [job.id]);
      await c.query('select pg_terminate_backend(pg_backend_pid())').catch(() => {});
      throw new Error('connection lost');
    };
    await runOneJob(options(dies)).catch(() => {});
    const [job] = await jobs();
    expect(job.status).toBe('pending');
    expect((await db.pool.query('select * from work_log')).rowCount).toBe(0);
  });

  it('only takes jobs of its own kind', async () => {
    await addJobs(1, 'other');
    expect(await runOneJob(options(async () => {}))).toBe('empty');
  });

  it('drains 200 jobs with 8 parallel loops, each job done exactly once', async () => {
    await addJobs(200);
    const counts = await drain(options(async (c, job) => void (await c.query(`insert into work_log values ($1, 'ok')`, [job.id])), { concurrency: 8 }));
    expect(counts.done).toBe(200);
    const { rows } = await db.pool.query('select count(*)::int as n, count(distinct job_id)::int as distinct_jobs from work_log');
    expect(rows[0]).toEqual({ n: 200, distinct_jobs: 200 });
  });

  it('a running worker picks up new jobs and stops cleanly', async () => {
    const worker = startWorker(options(async (c, job) => void (await c.query(`insert into work_log values ($1, 'ok')`, [job.id])), { idleMs: 20, concurrency: 3 }));
    await addJobs(5);
    for (let i = 0; i < 100 && (await jobs()).some((j) => j.status !== 'done'); i++) await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    await worker.stop();
    expect(Date.now() - started).toBeLessThan(500);
    expect((await jobs()).every((j) => j.status === 'done')).toBe(true);
  });

  describe('leased jobs (work that calls the outside world)', () => {
    const leased = (external: ExternalJobHandler, extra = {}) =>
      ({ pool: db.pool, log: silentLog, kind: 'test', external, backoff: () => 60_000, leaseMs: 30_000, ...extra });
    const row = async () => (await db.pool.query(`select status, attempts, locked_until > now() as leased, last_error from jobs`)).rows[0];

    it('holds no transaction during the work: the job is visibly "running" with a lease, then done', async () => {
      await addJobs(1);
      let during: unknown;
      expect(await runOneLeasedJob(leased(async () => void (during = await row())))).toBe('done');
      expect(during).toEqual({ status: 'running', attempts: 1, leased: true, last_error: null });
      expect(await row()).toEqual({ status: 'done', attempts: 1, leased: null, last_error: null });
    });

    it('records which process holds the lease (host:pid by default)', async () => {
      await db.pool.query(`insert into jobs (kind) values ('test'), ('test')`);
      let holder: string | undefined;
      const lockedBy = async () => (await db.pool.query(`select locked_by from jobs where status = 'running'`)).rows[0]?.locked_by;
      await runOneLeasedJob(leased(async () => void (holder = await lockedBy())));
      expect(holder).toBe(WORKER_ID);
      expect(WORKER_ID).toMatch(new RegExp(`:${process.pid}$`));
      await runOneLeasedJob(leased(async () => void (holder = await lockedBy()), { workerId: 'worker-b' }));
      expect(holder).toBe('worker-b');
    });

    it('a failure frees the job for a retry later', async () => {
      await addJobs(1);
      expect(await runOneLeasedJob(leased(async () => { throw new Error('ECONNREFUSED'); }))).toBe('retry');
      expect(await row()).toEqual({ status: 'pending', attempts: 1, leased: null, last_error: 'ECONNREFUSED' });
    });

    it('a job whose worker died (lease ran out) is taken again, and the attempt is counted', async () => {
      await db.pool.query(`insert into jobs (kind, status, attempts, locked_until) values ('test', 'running', 1, now() - interval '1 second')`);
      expect(await runOneLeasedJob(leased(async () => {}))).toBe('done');
      expect(await row()).toMatchObject({ status: 'done', attempts: 2 });
    });

    it('a job with a lease still running is left alone', async () => {
      await db.pool.query(`insert into jobs (kind, status, attempts, locked_until) values ('test', 'running', 1, now() + interval '1 minute')`);
      expect(await runOneLeasedJob(leased(async () => {}))).toBe('empty');
    });

    it('if the lease ran out and another worker took the job, the slow one does not overwrite it', async () => {
      await addJobs(1);
      // While "we" work, another worker takes the job over (its attempt number moves on).
      await runOneLeasedJob(leased(async () => void (await db.pool.query(`update jobs set attempts = attempts + 1`))));
      expect(await row()).toMatchObject({ status: 'running', attempts: 2 });
    });

    it('8 loops drain 100 leased jobs, each exactly once', async () => {
      await addJobs(100);
      const seen: string[] = [];
      const counts = await drain(leased(async (job) => void seen.push(job.id), { concurrency: 8 }));
      expect(counts.done).toBe(100);
      expect(new Set(seen).size).toBe(100);
      expect(seen).toHaveLength(100);
    });
  });
});
