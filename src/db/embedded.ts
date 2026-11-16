import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import type { Logger } from '../logger.ts';

const run = promisify(execFile);

// The embedded server only listens on localhost, so a fixed local password is fine.
const USER = 'postgres';
const PASSWORD = 'lead-intake-local';

export interface EmbeddedServer {
  /** Connection string for `database` on the embedded server. */
  url: string;
  /** Process id of the running Postgres server. */
  pid: number;
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

interface Binaries {
  initdb: string;
  pg_ctl: string;
  postgres: string;
}

/**
 * Starts a real Postgres server from the binaries npm installed (the
 * `@embedded-postgres/<os>-<cpu>` package for this machine). No Docker, no
 * admin rights. Data survives restarts.
 *
 * Starting and stopping go through `pg_ctl`, Postgres's own control tool. It
 * runs the server in a session of its own, so a Ctrl+C in the terminal reaches
 * only this Node process, which then shuts down in order: HTTP server,
 * connection pool, Postgres. Nothing else registers exit handlers that could
 * stop Postgres while the pool still holds connections.
 */
export async function startEmbeddedPostgres(opts: EmbeddedOptions): Promise<EmbeddedServer> {
  const { dir, port, database, log } = opts;
  const bin = await loadBinaries();
  const logFile = path.join(path.dirname(dir), 'postgres.log');

  if (!existsSync(path.join(dir, 'PG_VERSION'))) {
    log.info({ dir }, 'creating the embedded Postgres cluster (first run only)');
    await createCluster(bin, dir);
  }

  // A server still running here was left by a process that was killed hard
  // (kill -9, a crash). Stop it cleanly ("fast": open transactions roll back,
  // committed data stays), so this process starts one it controls.
  if (await isRunning(bin, dir)) {
    log.warn({ dir }, 'found a Postgres left running by a previous run; shutting it down');
    await stopServer(bin, dir);
  }

  try {
    await run(bin.pg_ctl, [
      'start', '-D', dir, '-l', logFile, '-w', '-t', '30',
      '-o', `-p ${port} -c listen_addresses=localhost`,
    ]);
  } catch (err) {
    throw new Error(`embedded Postgres did not start on port ${port}: ${await tail(logFile)} ${(err as Error).message}`);
  }

  await createDatabaseIfMissing(urlFor(port, 'postgres'), database);
  const pid = Number((await fs.readFile(path.join(dir, 'postmaster.pid'), 'utf8')).split('\n')[0]);
  log.info({ port, dir, database, pid }, 'embedded Postgres is running');

  return {
    url: urlFor(port, database),
    pid,
    stop: async () => {
      await stopServer(bin, dir);
      log.info('embedded Postgres stopped');
    },
  };
}

async function createCluster(bin: Binaries, dir: string): Promise<void> {
  await fs.mkdir(path.dirname(dir), { recursive: true });
  // initdb reads the password from a file, so it never shows up in a process list.
  const passwordFile = path.join(os.tmpdir(), `lead-intake-pw-${randomBytes(6).toString('hex')}`);
  await fs.writeFile(passwordFile, PASSWORD + '\n', { mode: 0o600 });
  try {
    await run(bin.initdb, [
      `--pgdata=${dir}`,
      `--username=${USER}`,
      `--pwfile=${passwordFile}`,
      '--auth=scram-sha-256',
      '--encoding=UTF8',
      '--no-locale', // the same sort order on every machine
    ]);
  } catch (err) {
    throw new Error(`could not create the embedded Postgres cluster: ${(err as { stderr?: string }).stderr || (err as Error).message}`);
  } finally {
    await fs.rm(passwordFile, { force: true });
  }
}

async function isRunning(bin: Binaries, dir: string): Promise<boolean> {
  try {
    await run(bin.pg_ctl, ['status', '-D', dir]);
    return true; // exit code 0: a server is running
  } catch {
    return false; // exit code 3: not running
  }
}

async function stopServer(bin: Binaries, dir: string): Promise<void> {
  await run(bin.pg_ctl, ['stop', '-D', dir, '-m', 'fast', '-w', '-t', '30']);
}

/** The binaries for this machine, from the platform package npm installed. */
async function loadBinaries(): Promise<Binaries> {
  const system = ({ win32: 'windows', darwin: 'darwin', linux: 'linux' } as Record<string, string>)[os.platform()];
  const pkg = `@embedded-postgres/${system}-${os.arch()}`;
  let bin: Binaries;
  try {
    if (!system) throw new Error('unsupported');
    bin = await import(pkg);
  } catch {
    throw new Error(`no embedded Postgres for ${os.platform()}-${os.arch()} (${pkg}); set DATABASE_URL instead`);
  }
  await ensureInstalled(bin);
  return bin;
}

/**
 * Repairs what npm's install script would have done, in case it did not run:
 * the binaries must be executable, and some libraries are reached through
 * symlinks listed in native/pg-symlinks.json.
 */
async function ensureInstalled(bin: Binaries): Promise<void> {
  if (os.platform() === 'win32') return;
  for (const file of [bin.initdb, bin.pg_ctl, bin.postgres]) {
    await fs.access(file, constants.X_OK).catch(() => fs.chmod(file, 0o755));
  }
  const packageRoot = path.resolve(path.dirname(bin.postgres), '..', '..');
  let links: { source: string; target: string }[] = [];
  try {
    links = JSON.parse(await fs.readFile(path.join(packageRoot, 'native', 'pg-symlinks.json'), 'utf8'));
  } catch {
    return;
  }
  for (const { source, target } of links) {
    const targetPath = path.resolve(packageRoot, target);
    if (existsSync(targetPath)) continue;
    await fs.symlink(path.relative(path.dirname(targetPath), path.resolve(packageRoot, source)), targetPath).catch(() => {});
  }
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

async function tail(file: string): Promise<string> {
  try {
    return (await fs.readFile(file, 'utf8')).trim().split('\n').slice(-5).join(' | ');
  } catch {
    return '(no Postgres log)';
  }
}
