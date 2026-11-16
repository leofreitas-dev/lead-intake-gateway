import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { Logger } from '../logger.ts';

// The embedded server only listens on localhost, so a fixed local password is fine.
const USER = 'postgres';
const PASSWORD = 'lead-intake-local';

export interface EmbeddedServer {
  /** Connection string for `database` on the embedded server. */
  url: string;
  stop(): Promise<void>;
}

export interface EmbeddedOptions {
  /** Folder that holds the cluster files. Created on first run. */
  dir: string;
  port: number;
  /** Database to create (if missing) and connect to. */
  database: string;
  log: Logger;
}

/**
 * Starts a real Postgres server from the binaries that npm installed with the
 * `embedded-postgres` package. No Docker, no admin rights. Data survives restarts.
 */
export async function startEmbeddedPostgres(opts: EmbeddedOptions): Promise<EmbeddedServer> {
  const { dir, port, database, log } = opts;
  const recentLines: string[] = [];
  const remember = (msg: unknown) => {
    const text = String(msg).trim();
    if (!text) return;
    recentLines.push(text);
    if (recentLines.length > 20) recentLines.shift();
    log.debug({ postgres: text }, 'embedded postgres');
  };

  const server = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: USER,
    password: PASSWORD,
    persistent: true,
    // Recreate the library symlinks at start if the npm install script did not run.
    autoRehydrateSymlinks: true,
    postgresFlags: ['-c', 'listen_addresses=localhost'],
    onLog: remember,
    onError: remember,
  });

  const firstRun = !existsSync(path.join(dir, 'PG_VERSION'));
  if (firstRun) {
    log.info({ dir }, 'creating the embedded Postgres cluster (first run only)');
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await server.initialise();
  }

  await stopOrphanedServer(dir, log);

  try {
    await server.start();
  } catch (err) {
    const detail = recentLines.slice(-5).join(' | ') || String(err ?? 'no output');
    throw new Error(`embedded Postgres did not start on port ${port}: ${detail}`);
  }

  const adminUrl = urlFor(port, 'postgres');
  await createDatabaseIfMissing(adminUrl, database);
  log.info({ port, dir, database }, 'embedded Postgres is running');

  return {
    url: urlFor(port, database),
    stop: async () => {
      await server.stop();
      log.info('embedded Postgres stopped');
    },
  };
}

function urlFor(port: number, database: string): string {
  return `postgres://${USER}:${PASSWORD}@localhost:${port}/${database}`;
}

async function createDatabaseIfMissing(adminUrl: string, database: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const found = await client.query('select 1 from pg_database where datname = $1', [database]);
    if (found.rowCount === 0) {
      await client.query(`create database ${client.escapeIdentifier(database)}`);
    }
  } finally {
    await client.end();
  }
}

/**
 * If the previous gateway process was killed hard (kill -9, a crash), its
 * Postgres keeps running on its own and holds the data folder. Ask that server
 * to shut down cleanly so this process can start its own. Postgres handles a
 * stale lock file from a dead server by itself.
 */
async function stopOrphanedServer(dir: string, log: Logger): Promise<void> {
  const pidFile = path.join(dir, 'postmaster.pid');
  let pid: number;
  try {
    pid = Number((await fs.readFile(pidFile, 'utf8')).split('\n')[0]);
  } catch {
    return; // no lock file: nothing is running
  }
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid) || !(await looksLikePostgres(pid))) return;

  log.warn({ pid }, 'found a Postgres left running by a previous run; shutting it down');
  process.kill(pid, 'SIGINT'); // "fast shutdown": rolls back open transactions, keeps committed data
  for (let waited = 0; waited < 15_000; waited += 100) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the old Postgres (pid ${pid}) did not stop; stop it and run again`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Guards against a recycled pid. Only Linux exposes /proc; elsewhere trust the lock file. */
async function looksLikePostgres(pid: number): Promise<boolean> {
  try {
    const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('postgres');
  } catch {
    return process.platform !== 'linux';
  }
}
