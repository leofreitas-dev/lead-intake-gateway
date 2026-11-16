import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The first start on a fresh clone runs initdb while the other test files keep
// the machine busy: on a slow disk that can take a while. Generous on purpose:
// a slow start is not what this test is about.
const STARTUP_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

// Runs the real gateway (src/main.ts) as its own process group and presses
// "Ctrl+C": SIGINT to the whole group, the way a terminal does it.
describe.skipIf(process.platform === 'win32')('Ctrl+C on a running gateway', () => {
  let dataDir: string;
  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lead-intake-shutdown-'));
  });
  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('closes the server, then the workers, then the pool, then Postgres, and exits 0', async () => {
    const port = 3291;
    const child = spawn(process.execPath, ['src/main.ts'], {
      detached: true, // its own process group, like a terminal session
      env: {
        ...process.env,
        DATABASE_URL: '',
        DATA_DIR: dataDir,
        PORT: String(port),
        EMBEDDED_PG_PORT: '25436',
        LOG_PRETTY: '0',
        LOG_LEVEL: 'info',
        AI_MODE: 'recorded',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    let exitCode: number | null | undefined;
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => {
        exitCode = code;
        resolve(code);
      }),
    );
    // Only complete JSON lines: a line still being written is not parsed.
    const messages = () =>
      output
        .split('\n')
        .slice(0, -1)
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line).msg as string);

    try {
      // Ready means: /ready answers 200 AND main.ts has finished starting (workers
      // running, Ctrl+C handler installed), which it says with its "ready:" line.
      const base = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      for (;;) {
        if (exitCode !== undefined) throw new Error(`gateway exited during startup (code ${exitCode}):\n${output}`);
        const ok = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok, () => false);
        if (ok && messages().some((m) => m.startsWith('ready:'))) break;
        if (Date.now() > deadline) throw new Error(`gateway not ready after ${STARTUP_TIMEOUT_MS / 1000}s:\n${output}`);
        await new Promise((r) => setTimeout(r, 250));
      }
      // Leave idle connections in its pool: they used to be reported as "lost".
      await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/ready`)));

      process.kill(-child.pid!, 'SIGINT');
      const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), SHUTDOWN_TIMEOUT_MS))]);
      expect(code, output).toBe(0);
    } finally {
      // Never leave a gateway (and its Postgres, which runs in its own session) behind after a failure.
      if (exitCode === undefined) {
        process.kill(-child.pid!, 'SIGKILL');
        await stopOrphanPostgres(path.join(dataDir, 'pg'));
      }
    }

    const msgs = messages();
    expect(msgs).not.toContain('an idle database connection was lost');
    // The two workers stop at the same time, so their lines can come in either
    // order; what matters is what happens before and after them.
    const shuttingDown = msgs.indexOf('shutting down');
    const workersStopped = msgs.flatMap((m, i) => (m === 'worker stopped' ? [i] : []));
    const postgresStopped = msgs.indexOf('embedded Postgres stopped');
    expect(shuttingDown, output).toBeGreaterThanOrEqual(0);
    expect(workersStopped, output).toHaveLength(2);
    expect(Math.min(...workersStopped)).toBeGreaterThan(shuttingDown);
    expect(postgresStopped).toBeGreaterThan(Math.max(...workersStopped));
    expect(postgresStopped).toBe(msgs.length - 1); // Postgres is the very last thing
  }, STARTUP_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS + 10_000);
});

/** Fast shutdown of a Postgres whose gateway was killed: its pid is on the first line of postmaster.pid. */
async function stopOrphanPostgres(pgDir: string) {
  const pid = Number((await fs.readFile(path.join(pgDir, 'postmaster.pid'), 'utf8').catch(() => '')).split('\n')[0]);
  if (pid > 0) {
    try {
      process.kill(pid, 'SIGQUIT');
    } catch {
      // already gone
    }
  }
}
