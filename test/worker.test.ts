import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.ts';
import { backoffMs } from '../src/queue/backoff.ts';
import { drain, runOneJob, startWorker, type JobHandler } from '../src/queue/worker.ts';
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
});
