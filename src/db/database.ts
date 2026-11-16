import path from 'node:path';
import pg from 'pg';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { startEmbeddedPostgres } from './embedded.ts';

export interface Database {
  pool: pg.Pool;
  /** True when this process started its own embedded Postgres. */
  embedded: boolean;
  close(): Promise<void>;
}

export const EMBEDDED_DATABASE_NAME = 'lead_intake';

/**
 * Uses DATABASE_URL when it is set (Docker, CI, a hosted Postgres).
 * Otherwise starts the embedded Postgres, so the demo needs nothing installed.
 */
export async function openDatabase(
  config: Pick<Config, 'databaseUrl' | 'dataDir' | 'embeddedPgPort'>,
  log: Logger,
): Promise<Database> {
  if (config.databaseUrl) {
    const pool = createPool(config.databaseUrl, log);
    log.info({ database: describeUrl(config.databaseUrl) }, 'using the Postgres from DATABASE_URL');
    return { pool, embedded: false, close: () => endPool(pool) };
  }

  const server = await startEmbeddedPostgres({
    dir: path.join(config.dataDir, 'pg'),
    port: config.embeddedPgPort,
    database: EMBEDDED_DATABASE_NAME,
    log,
  });
  const pool = createPool(server.url, log);
  return {
    pool,
    embedded: true,
    close: async () => {
      await endPool(pool);
      await server.stop();
    },
  };
}

/**
 * Closes every connection of the pool and waits until each one is really
 * closed. pool.end() alone resolves as soon as the connections are taken off
 * its list, while each one is still saying goodbye to Postgres; stopping
 * Postgres right then cut those goodbyes short ("terminating connection due to
 * administrator command" on an idle connection).
 */
export async function endPool(pool: pg.Pool, timeoutMs = 5_000): Promise<void> {
  const open = pool.totalCount;
  let closed = 0;
  let timer: NodeJS.Timeout | undefined;
  const allClosed = new Promise<void>((resolve) => {
    if (open === 0) return resolve();
    pool.on('remove', () => {
      if (++closed >= open) resolve();
    });
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
  await pool.end();
  await allClosed;
  clearTimeout(timer);
}

export function createPool(connectionString: string, log: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    // Fail fast instead of hanging when the database is down, so /ready answers quickly.
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle connection can drop when Postgres restarts. Without this handler,
  // that error would crash the whole process.
  pool.on('error', (err) => log.warn({ err: err.message }, 'an idle database connection was lost'));
  return pool;
}

/** host:port/database, without the password, for logs. */
export function describeUrl(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || 5432}${url.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

/**
 * Takes a connection from the pool for a transaction. If the connection breaks
 * while it is checked out (Postgres restarted, network cut), the error is caught
 * here instead of crashing the process, and the broken connection is thrown away
 * instead of going back to the pool.
 */
export async function checkout(pool: pg.Pool): Promise<{ client: pg.PoolClient; release(discard?: boolean): void }> {
  const client = await pool.connect();
  let broken: Error | undefined;
  const onError = (err: Error) => {
    broken = err;
  };
  client.on('error', onError);
  return {
    client,
    // discard: throw the connection away even if no error event came (a query failed in an unknown state).
    release: (discard = false) => {
      client.off('error', onError);
      client.release(broken ?? discard);
    },
  };
}
