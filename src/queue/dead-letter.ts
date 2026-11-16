import type pg from 'pg';

export interface DeadJob {
  id: string;
  kind: string;
  attempts: number;
  last_error: string | null;
  failed_at: Date;
  replays: number;
  trace_id: string | null;
  payload: Record<string, unknown>;
}

const COLUMNS = 'id, kind, attempts, last_error, updated_at as failed_at, replays, trace_id, payload';

/** The jobs that ran out of attempts (or failed for good), newest first. */
export async function listDeadJobs(pool: pg.Pool, { kind, limit = 100 }: { kind?: string; limit?: number } = {}): Promise<DeadJob[]> {
  const { rows } = await pool.query<DeadJob>(
    `select ${COLUMNS} from jobs where status = 'dead' and ($1::text is null or kind = $1) order by updated_at desc, id desc limit $2`,
    [kind ?? null, limit],
  );
  return rows;
}

/**
 * Replay: sends dead jobs back to the queue, with their attempts reset, to run
 * now. Only dead jobs move (a job that is pending, running or done is left
 * alone), so replaying twice by mistake does nothing the second time. The last
 * error stays on the row, and `replays` counts how often a person did this.
 */
export async function replayDeadJobs(pool: pg.Pool, which: { ids: string[] } | { all: true; kind?: string }): Promise<DeadJob[]> {
  const byIds = 'ids' in which;
  const { rows } = await pool.query<DeadJob>(
    `update jobs
        set status = 'pending', attempts = 0, run_at = now(), locked_until = null,
            replays = replays + 1, last_replayed_at = now(), updated_at = now()
      where status = 'dead'
        and ${byIds ? 'id = any($1::bigint[])' : '($1::text is null or kind = $1)'}
      returning ${COLUMNS}`,
    [byIds ? which.ids : (which.kind ?? null)],
  );
  return rows;
}
