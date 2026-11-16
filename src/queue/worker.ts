import type pg from 'pg';
import { checkout } from '../db/database.ts';
import type { Logger } from '../logger.ts';
import { backoffMs } from './backoff.ts';

export interface Job {
  id: string;
  kind: string;
  inbox_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  trace_id: string | null;
}

/**
 * Does the work of one job inside the worker's transaction. Everything it
 * writes commits together with "job done", or rolls back with it.
 */
export type JobHandler = (client: pg.PoolClient, job: Job, log: Logger) => Promise<void>;

export interface WorkerOptions {
  pool: pg.Pool;
  log: Logger;
  kind: string;
  handler: JobHandler;
  /** Jobs worked on at the same time by this process. */
  concurrency?: number;
  /** How long to sleep when the queue is empty. */
  idleMs?: number;
  backoff?: (attempt: number) => number;
}

export type JobOutcome = 'done' | 'retry' | 'dead' | 'empty';

/**
 * Takes one ready job of `kind` and runs it.
 *
 * FOR UPDATE SKIP LOCKED: the row is locked by this transaction, and any other
 * worker looking at the same moment skips it and takes the next one, instead of
 * waiting or taking the same job. Claim, work and "done" commit together, so if
 * the process dies halfway the transaction disappears, the lock is released and
 * the job is simply still pending. Nothing is half done.
 */
export async function runOneJob(opts: WorkerOptions): Promise<JobOutcome> {
  const { pool, log, kind, handler } = opts;
  const { client, release } = await checkout(pool);
  let job: Job | undefined;
  try {
    await client.query('begin');
    const { rows } = await client.query<Job>(
      `select id, kind, inbox_id, payload, attempts, max_attempts, trace_id
         from jobs
        where status = 'pending' and kind = $1 and run_at <= now()
        order by run_at, id
        limit 1
        for update skip locked`,
      [kind],
    );
    job = rows[0];
    if (!job) {
      await client.query('commit');
      return 'empty';
    }
    const jobLog = log.child({ job_id: job.id, kind, trace_id: job.trace_id });
    await handler(client, job, jobLog);
    await client.query(
      `update jobs set status = 'done', attempts = attempts + 1, last_error = null, updated_at = now() where id = $1`,
      [job.id],
    );
    await client.query('commit');
    return 'done';
  } catch (err) {
    await client.query('rollback').catch(() => {});
    if (!job) throw err; // could not even claim: a database problem, not a job problem
    return recordFailure(opts, job, err as Error);
  } finally {
    release();
  }
}

/** The work was rolled back. Count the attempt and schedule a retry, or give up. */
async function recordFailure(opts: WorkerOptions, job: Job, err: Error): Promise<JobOutcome> {
  const attempt = job.attempts + 1;
  const dead = attempt >= job.max_attempts;
  const delay = (opts.backoff ?? backoffMs)(attempt);
  await opts.pool.query(
    `update jobs
        set attempts = $2, last_error = $3, updated_at = now(),
            status = case when $4 then 'dead' else 'pending' end,
            run_at = now() + make_interval(secs => $5::double precision / 1000)
      where id = $1`,
    [job.id, attempt, err.message.slice(0, 2000), dead, delay],
  );
  const fields = { job_id: job.id, kind: job.kind, trace_id: job.trace_id, attempt, err: err.message };
  if (dead) opts.log.error(fields, 'job failed for the last time: moved to dead-letter');
  else opts.log.warn({ ...fields, retry_in_ms: delay }, 'job failed: will retry');
  return dead ? 'dead' : 'retry';
}

/** Runs jobs until the queue has nothing ready. For the demo and tests. */
export async function drain(opts: WorkerOptions): Promise<Record<JobOutcome, number>> {
  const counts: Record<JobOutcome, number> = { done: 0, retry: 0, dead: 0, empty: 0 };
  const loop = async () => {
    for (;;) {
      const outcome = await runOneJob(opts);
      counts[outcome]++;
      if (outcome === 'empty') return;
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, loop));
  return counts;
}

/**
 * Keeps `concurrency` loops taking jobs; sleeps `idleMs` when there is nothing
 * to do. stop() lets the jobs in progress finish, then resolves.
 */
export function startWorker(opts: WorkerOptions): { stop(): Promise<void> } {
  const { log, idleMs = 250 } = opts;
  let stopping = false;
  const sleepers = new Set<() => void>();
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      sleepers.add(wake);
    });

  const loop = async () => {
    while (!stopping) {
      try {
        if ((await runOneJob(opts)) === 'empty') await sleep(idleMs);
      } catch (err) {
        log.error({ kind: opts.kind, err: (err as Error).message }, 'worker could not reach the queue; retrying');
        await sleep(2_000);
      }
    }
  };
  const loops = Array.from({ length: opts.concurrency ?? 4 }, loop);
  log.info({ kind: opts.kind, concurrency: loops.length }, 'worker started');

  return {
    stop: async () => {
      stopping = true;
      for (const wake of [...sleepers]) wake();
      await Promise.all(loops);
      log.info({ kind: opts.kind }, 'worker stopped');
    },
  };
}
