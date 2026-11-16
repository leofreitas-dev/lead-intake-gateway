import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
      env: { ...process.env, DATABASE_URL: '', DATA_DIR: dataDir, PORT: String(port), EMBEDDED_PG_PORT: '54333', LOG_PRETTY: '0', LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

    // Wait until it answers, then leave idle connections in its pool.
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100 && !(await fetch(`${base}/ready`).then((r) => r.ok, () => false)); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/ready`)));

    process.kill(-child.pid!, 'SIGINT');
    const code = await exited;

    const messages = output
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line).msg as string);
    expect(code).toBe(0);
    expect(messages).not.toContain('an idle database connection was lost');
    expect(messages.slice(-4)).toEqual(['shutting down', 'worker stopped', 'worker stopped', 'embedded Postgres stopped']);
  }, 60_000);
});
