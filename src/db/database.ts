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
    return { pool, embedded: false, close: () => pool.end() };
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
      await pool.end();
      await server.stop();
    },
  };
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
