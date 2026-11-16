import type pg from 'pg';
import { checkout } from '../db/database.ts';
import type { Source } from '../sources.ts';
import type { IdempotencyKey } from './idempotency.ts';

export interface IncomingWebhook {
  source: Source;
  idempotency: IdempotencyKey;
  headers: Record<string, unknown>;
  rawBody: string;
  traceId: string;
  remoteAddr: string;
  /** Why the body cannot be processed (not JSON, not an object), or undefined when it is fine. */
  parseError: string | undefined;
}

export interface StoredWebhook {
  inboxId: string;
  /** The trace id of the first delivery. A resend keeps the original one. */
  traceId: string;
  duplicate: boolean;
  parseError: string | null;
}

export const PROCESS_JOB = 'process';

/**
 * Stores the raw webhook and queues the "process" job in ONE transaction:
 * either both exist or neither does. A resend (same source + key) changes
 * nothing and returns the row that is already there.
 */
export async function storeWebhook(pool: pg.Pool, webhook: IncomingWebhook): Promise<StoredWebhook> {
  const { client, release } = await checkout(pool);
  try {
    await client.query('begin');
    // If an identical webhook is being stored by another request right now,
    // this insert waits for that transaction, then does nothing.
    const inserted = await client.query<{ id: string }>(
      `insert into inbox (source, idempotency_key, idempotency_from, headers, body, trace_id, remote_addr, parse_error)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (source, idempotency_key) do nothing
       returning id`,
      [
        webhook.source,
        webhook.idempotency.key,
        webhook.idempotency.from,
        JSON.stringify(webhook.headers),
        webhook.rawBody,
        webhook.traceId,
        webhook.remoteAddr,
        webhook.parseError ?? null,
      ],
    );

    let result: StoredWebhook;
    if (inserted.rowCount === 1) {
      const inboxId = inserted.rows[0].id;
      if (!webhook.parseError) {
        await client.query(`insert into jobs (kind, inbox_id, trace_id) values ($1, $2, $3)`, [
          PROCESS_JOB,
          inboxId,
          webhook.traceId,
        ]);
      }
      result = { inboxId, traceId: webhook.traceId, duplicate: false, parseError: webhook.parseError ?? null };
    } else {
      const existing = await client.query<{ id: string; trace_id: string; parse_error: string | null }>(
        `select id, trace_id, parse_error from inbox where source = $1 and idempotency_key = $2`,
        [webhook.source, webhook.idempotency.key],
      );
      const row = existing.rows[0];
      result = { inboxId: row.id, traceId: row.trace_id, duplicate: true, parseError: row.parse_error };
    }
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    release();
  }
}

/** A lead body must be a JSON object. Returns why not, or undefined when it is fine. */
export function checkBody(rawBody: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    return `invalid JSON: ${(err as Error).message}`;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'the body must be a JSON object';
  }
  return undefined;
}
