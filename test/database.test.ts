import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.ts';
import { silentLog } from './helpers.ts';

/** A logger that keeps every line, to check what was (not) logged. */
function capturingLog() {
  const lines: { level: number; msg: string }[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(String(chunk)));
      done();
    },
  });
  return { log: pino({ level: 'debug' }, stream), lines };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Starts its own embedded Postgres (also in CI) to prove the zero-install path works.
describe('openDatabase without DATABASE_URL', () => {
  let dataDir: string;
  const config = () => ({ databaseUrl: undefined, dataDir, embeddedPgPort: 54332 });

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lead-intake-db-'));
  });
  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('starts a real Postgres 18 and keeps the data after a restart', async () => {
    const first = await openDatabase(config(), silentLog);
    expect(first.embedded).toBe(true);
    const version = await first.pool.query<{ server_version_num: string }>('show server_version_num');
    expect(Number(version.rows[0].server_version_num)).toBeGreaterThanOrEqual(180000);
    await first.pool.query('create table notes (text text)');
    await first.pool.query(`insert into notes values ('still here')`);
    await first.close();

    const second = await openDatabase(config(), silentLog);
    const rows = await second.pool.query('select text from notes');
    expect(rows.rows).toEqual([{ text: 'still here' }]);
    await second.close();
  });

  it('shuts down cleanly: pool first, then Postgres, with no lost-connection warning', async () => {
    const { log, lines } = capturingLog();
    const db = await openDatabase(config(), log);
    // Leave several idle connections in the pool, as a running gateway would.
    await Promise.all(Array.from({ length: 5 }, () => db.pool.query('select pg_sleep(0.05)')));
    expect(db.pool.idleCount).toBeGreaterThan(1);

    await db.close();
    const messages = lines.map((l) => l.msg);
    expect(messages).not.toContain('an idle database connection was lost');
    expect(messages.at(-1)).toBe('embedded Postgres stopped');
  });

  it.skipIf(process.platform !== 'linux')(
    'runs Postgres in a session of its own, so a Ctrl+C in the terminal reaches only Node',
    async () => {
      const { log, lines } = capturingLog();
      const db = await openDatabase(config(), log);
      try {
        const started = lines.find((l) => l.msg === 'embedded Postgres is running') as unknown as { pid: number };
        const sessionOf = (pid: number) => execFileSync('ps', ['-o', 'sid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        expect(sessionOf(started.pid)).not.toBe(sessionOf(process.pid));
      } finally {
        await db.close();
      }
    },
  );

  it('takes over a Postgres left running by a process that was killed hard', async () => {
    const { log, lines } = capturingLog();
    const crashed = await openDatabase(config(), silentLog);
    await crashed.pool.query(`insert into notes values ('written before the crash')`);
    await crashed.pool.end(); // the process "dies": its Postgres is never stopped
    const orphan = Number((await fs.readFile(path.join(dataDir, 'pg', 'postmaster.pid'), 'utf8')).split('\n')[0]);
    expect(isAlive(orphan)).toBe(true);

    const next = await openDatabase(config(), log);
    try {
      expect(lines.map((l) => l.msg)).toContain('found a Postgres left running by a previous run; shutting it down');
      expect(isAlive(orphan)).toBe(false);
      const rows = await next.pool.query('select text from notes order by text');
      expect(rows.rows.map((r) => r.text)).toEqual(['still here', 'written before the crash']);
    } finally {
      await next.close();
    }
  });
});
