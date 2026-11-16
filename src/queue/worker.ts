import type pg from 'pg';
import { checkout } from '../db/database.ts';
import type { Logger } from '../logger.ts';
import { backoffMs } from './backoff.ts';

export interface Job {
  id: string;
  kind: string;
  inbox_id: string | null;
  payload: Record<string, unknown>;
  /** Attempts already made. In a leased job the current one is already counted. */
  attempts: number;
  max_attempts: number;
  trace_id: string | null;
}

/**
 * Does the work of one job inside the worker's transaction. Everything it
 * writes commits together with "job done", or rolls back with it.
 * For work that only touches this database.
 */
export type JobHandler = (client: pg.PoolClient, job: Job, log: Logger) => Promise<void>;

/**
 * Does the work of one leased job, with no transaction open: for work that
 * calls something outside (the CRM). It must be safe to repeat, because a
 * worker that dies after the call but before "done" leaves the job to run again.
 */
export type ExternalJobHandler = (job: Job, log: Logger) => Promise<void>;

/**
 * What a handler can say about a failure, on the error it throws:
 * retryable: false → no point trying again (the CRM refused the data): dead-letter now.
 * retryAfterMs → the other side asked us to wait at least this long (429 Retry-After).
 */
export interface JobFailure {
  retryable?: boolean;
  retryAfterMs?: number;
}

/**
 * Decides whether loops may take a job now. A circuit breaker uses it to pause
 * a destination that is down. Returns how long to wait; 0 means go.
 */
export interface Gate {
  waitMs(): number;
  /** Called when the gate let a loop through but there was no job to take. */
  nothingClaimed?(): void;
}

interface CommonOptions {
  pool: pg.Pool;
  log: Logger;
  kind: string;
  /** Jobs worked on at the same time by this process. */
  concurrency?: number;
  /** How long to sleep when the queue is empty. */
  idleMs?: number;
  backoff?: (attempt: number) => number;
  /** Overrides the job's own max_attempts. */
  maxAttempts?: number;
  gate?: Gate;
}

export interface WorkerOptions extends CommonOptions {
  handler: JobHandler;
}

export interface LeasedWorkerOptions extends CommonOptions {
  external: ExternalJobHandler;
  /** How long a claimed job stays reserved. If the worker dies, the job frees itself after this. */
  leaseMs?: number;
}

export type AnyWorkerOptions = WorkerOptions | LeasedWorkerOptions;

export type JobOutcome = 'done' | 'retry' | 'dead' | 'empty';

const JOB_COLUMNS = 'id, kind, inbox_id, payload, attempts, max_attempts, trace_id';

/**
 * Takes one ready job of `kind` and runs it in one transaction.
 *
 * FOR UPDATE SKIP LOCKED: the row is locked by this transaction, and any other
 * worker looking at the same moment skips it and takes the next one, instead of
 * waiting or taking the same job. Claim, work and "done" commit together, so if
 * the process dies halfway the transaction disappears, the lock is released and
 * the job is simply still pending. Nothing is half done.
 *
 * A failure is recorded while the row is still locked (the work is undone back
 * to a savepoint, the attempt is counted, then commit), so no other loop can
 * take the job in between and try it a second time right away.
 */
export async function runOneJob(opts: WorkerOptions): Promise<JobOutcome> {
  const { pool, log, kind, handler } = opts;
  const { client, release } = await checkout(pool);
  let job: Job | undefined;
  let broken = false;
  try {
    await client.query('begin');
    const { rows } = await client.query<Job>(
      `select ${JOB_COLUMNS}
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
    await client.query('savepoint work');
    const jobLog = log.child({ job_id: job.id, kind, trace_id: job.trace_id });
    try {
      await handler(client, job, jobLog);
    } catch (err) {
      // Undo the work, keep the lock, count the attempt, commit.
      await client.query('rollback to savepoint work');
      const outcome = await recordFailure(client, opts, job, job.attempts + 1, err);
      await client.query('commit');
      return outcome;
    }
    await client.query(
      `update jobs set status = 'done', attempts = attempts + 1, last_error = null, updated_at = now() where id = $1`,
      [job.id],
    );
    await client.query('commit');
    return 'done';
  } catch (err) {
    // The connection itself failed (or the commit did). Everything is rolled back.
    broken = true;
    await client.query('rollback').catch(() => {});
    if (!job) throw err; // could not even claim: a database problem, not a job problem
    return recordFailure(pool, opts, job, job.attempts + 1, err);
  } finally {
    release(broken);
  }
}

/**
 * Takes one ready job of `kind` with a lease, and runs it with no transaction open.
 *
 * Claiming is a short transaction: SKIP LOCKED picks a job, marks it "running"
 * until now + lease, counts the attempt, commits. Then the handler calls the
 * outside world for as long as it needs, without holding a database lock or
 * connection. Then a second short statement says "done" or records the failure.
 * If the worker dies in between, the lease runs out and another worker takes
 * the job again: the handler must be safe to repeat (the CRM call is an upsert).
 */
export async function runOneLeasedJob(opts: LeasedWorkerOptions): Promise<JobOutcome> {
  const { pool, log, kind, external, leaseMs = 30_000 } = opts;
  const { rows } = await pool.query<Job>(
    `update jobs
        set status = 'running', attempts = attempts + 1, updated_at = now(),
            locked_until = now() + make_interval(secs => $2::double precision / 1000)
      where id = (
        select id from jobs
         where kind = $1
           and ((status = 'pending' and run_at <= now())
             or (status = 'running' and locked_until < now()))  -- a lease that ran out: its worker died
         order by run_at, id
         limit 1
         for update skip locked)
      returning ${JOB_COLUMNS}`,
    [kind, leaseMs],
  );
  const job = rows[0];
  if (!job) return 'empty';
  const jobLog = log.child({ job_id: job.id, kind, trace_id: job.trace_id, attempt: job.attempts });
  try {
    await external(job, jobLog);
  } catch (err) {
    return recordFailure(pool, opts, job, job.attempts, err, true);
  }
  // Only if the lease is still ours (same attempt): otherwise another worker has the job now.
  const done = await pool.query(
    `update jobs set status = 'done', locked_until = null, last_error = null, updated_at = now()
      where id = $1 and status = 'running' and attempts = $2`,
    [job.id, job.attempts],
  );
  if (done.rowCount === 0) jobLog.warn('lease ran out before the job finished; another worker owns it now');
  return 'done';
}

/** Counts the attempt and schedules a retry with backoff, or moves the job to dead-letter. */
async function recordFailure(
  db: pg.Pool | pg.PoolClient,
  opts: CommonOptions,
  job: Job,
  attempt: number,
  error: unknown,
  leased = false,
): Promise<JobOutcome> {
  const err = error as Error & JobFailure;
  const maxAttempts = opts.maxAttempts ?? job.max_attempts;
  const permanent = err.retryable === false;
  const dead = permanent || attempt >= maxAttempts;
  const delay = Math.max((opts.backoff ?? backoffMs)(attempt), err.retryAfterMs ?? 0);
  const result = await db.query(
    `update jobs
        set attempts = $2, last_error = $3, updated_at = now(), locked_until = null,
            status = case when $4 then 'dead' else 'pending' end,
            run_at = now() + make_interval(secs => $5::double precision / 1000)
      where id = $1 ${leased ? `and status = 'running' and attempts = $2` : ''}`,
    [job.id, attempt, String(err.message ?? err).slice(0, 2000), dead, delay],
  );
  const fields = { job_id: job.id, kind: job.kind, trace_id: job.trace_id, attempt, max_attempts: maxAttempts, err: err.message };
  if (result.rowCount === 0) {
    opts.log.warn(fields, 'job failed after its lease ran out; another worker owns it now');
    return 'retry';
  }
  const what = `${job.kind} #${job.id} attempt ${attempt} of ${maxAttempts} failed (${fields.err})`;
  if (dead) {
    opts.log.error(fields, permanent ? `${what}; retrying cannot help: moved to dead-letter` : `${what}; no attempts left: moved to dead-letter`);
  } else {
    opts.log.warn({ ...fields, retry_in_ms: delay }, `${what}; next attempt in ${formatMs(delay)}`);
  }
  return dead ? 'dead' : 'retry';
}

function runOne(opts: AnyWorkerOptions): Promise<JobOutcome> {
  return 'external' in opts ? runOneLeasedJob(opts) : runOneJob(opts);
}

/**
 * Runs jobs until the queue has nothing ready (for the demo and tests). With a
 * gate, waits while the gate is closed instead of stopping.
 */
export async function drain(opts: AnyWorkerOptions): Promise<Record<JobOutcome, number>> {
  const counts: Record<JobOutcome, number> = { done: 0, retry: 0, dead: 0, empty: 0 };
  const loop = async () => {
    for (;;) {
      const wait = opts.gate?.waitMs() ?? 0;
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, Math.min(wait, 1_000)));
        continue;
      }
      const outcome = await runOne(opts);
      counts[outcome]++;
      if (outcome === 'empty') {
        opts.gate?.nothingClaimed?.();
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, loop));
  return counts;
}

/**
 * Keeps `concurrency` loops taking jobs; sleeps `idleMs` when there is nothing
 * to do, and while the gate is closed. stop() lets the jobs in progress
 * finish, then resolves.
 */
export function startWorker(opts: AnyWorkerOptions): { stop(): Promise<void> } {
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
        const wait = opts.gate?.waitMs() ?? 0;
        if (wait > 0) {
          await sleep(Math.min(wait, 1_000));
          continue;
        }
        if ((await runOne(opts)) === 'empty') {
          opts.gate?.nothingClaimed?.();
          await sleep(idleMs);
        }
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

function formatMs(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1_000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}
