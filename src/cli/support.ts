// Shared by npm run chaos and npm run bench: start real processes, wait for
// something to be true, and say which commit and machine produced a report.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Proc { name: string; child: ChildProcess; pid: number; logFile: string; exited: Promise<number | null> }

/** Starts `node <script>` with its output in <logDir>/<name>.log; remembers it in `procs`. */
export function nodeStarter(logDir: string, procs: Proc[]) {
  return (name: string, script: string, env: Record<string, string>, args: string[] = []): Proc => {
    const logFile = path.join(logDir, `${name}.log`);
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', out, out] });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const proc = { name, child, pid: child.pid!, logFile, exited };
    procs.push(proc);
    return proc;
  };
}

/** Ctrl+C to each process, then kill -9 to any still running after 20 s. */
export async function stopAll(procs: Proc[]) {
  for (const p of procs) if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGINT');
  await Promise.race([Promise.all(procs.map((p) => p.exited)), sleep(20_000)]);
  for (const p of procs) if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGKILL');
}

export async function waitFor<T>(what: string, check: () => Promise<T | undefined | false>, timeoutMs: number, everyMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check().catch(() => undefined);
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(everyMs);
  }
}

/** The short commit, marked when the working tree has uncommitted changes. */
export function currentCommit(): string {
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no']).toString().trim() !== '';
  return dirty ? `${commit} (with uncommitted changes)` : commit;
}

/**
 * The p-th percentile of numbers sorted from small to large ("nearest rank"):
 * the smallest value with at least p% of the values at or below it. p95 of
 * 100 latencies is the 95th smallest. NaN for an empty list.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** What the numbers were measured on. */
export function machine() {
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model.trim() ?? 'unknown',
    cpus: cpus.length,
    memory_gb: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.platform()} ${os.release()}${/microsoft/i.test(os.release()) ? ' (WSL2)' : ''}`,
    node: process.version,
  };
}
