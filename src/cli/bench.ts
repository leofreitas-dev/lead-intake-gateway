// npm run bench [-- --rate 200 --seconds 15 --connections 32]
//
// Measures the gateway (POST /webhooks/:source) with real processes: its own
// fresh Postgres (data/bench/pg), the fake CRM, and the gateway as `npm start`
// runs it (HTTP + workers, logs at info, AI replaying recordings). Signed
// webhooks of fictional people (from the chaos plan), over the 4 channels,
// each one a new webhook (a fresh X-Event-Id).
//
//   1. warm-up: a few seconds, not counted;
//   2. steady load: --rate requests/s on a fixed schedule. Latency is measured
//      from the moment each request was DUE, not when it went out, so a slow
//      server cannot hide its own queue ("coordinated omission"). This gives p50/p95/p99;
//   3. maximum: --connections requests in flight all the time, for the most requests/s.
//
// Then it checks that every webhook answered 202 is in the database (0 lost).
// The report goes to reports/, with the command, the machine and the commit.
// The load generator runs on the same machine as the server: numbers are for this machine.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { makePlan } from '../chaos/plan.ts';
import { loadConfig } from '../config.ts';
import { createPool, endPool } from '../db/database.ts';
import { startEmbeddedPostgres } from '../db/embedded.ts';
import { migrate } from '../db/migrate.ts';
import { signatureHeader } from '../gateway/signature.ts';
import { createLogger } from '../logger.ts';
import { currentCommit, machine, nodeStarter, percentile, type Proc, sleep, stopAll, waitFor } from './support.ts';

const { values } = parseArgs({
  options: {
    rate: { type: 'string', default: '200' },
    seconds: { type: 'string', default: '15' },
    connections: { type: 'string', default: '32' },
    'warmup-seconds': { type: 'string', default: '3' },
    seed: { type: 'string', default: '1' },
    layout: { type: 'string', default: 'one' },
    'pg-port': { type: 'string', default: '25439' },
    'http-port': { type: 'string', default: '3295' },
    'crm-port': { type: 'string', default: '4015' },
  },
});
const rate = Number(values.rate);
const seconds = Number(values.seconds);
const connections = Number(values.connections);
const warmupSeconds = Number(values['warmup-seconds']);
// one: a single process with HTTP and workers, as `npm start` runs it.
// split: an HTTP-only process (ROLE=http) and a worker process (ROLE=worker) on the same database.
const layout = values.layout;
if (layout !== 'one' && layout !== 'split') throw new Error('--layout must be "one" or "split"');
const LAYOUTS = {
  one: 'one process with HTTP and the workers (process, classify, draft, deliver), as npm start runs it',
  split: 'two processes on the same database: HTTP only (ROLE=http) and the workers (ROLE=worker)',
};
const command = `npm run bench${process.argv.length > 2 ? ` -- ${process.argv.slice(2).join(' ')}` : ''}`;

// The bench never touches the gateway's own database or settings.
const config = loadConfig({ ...process.env, DATABASE_URL: '' });
const dir = path.join(config.dataDir, 'bench');
const logDir = path.join(dir, 'logs');
const reportsDir = path.resolve('reports');
const log = createLogger({ logLevel: 'error', logPretty: false });
const port = Number(values['http-port']);
const crmUrl = `http://127.0.0.1:${values['crm-port']}`;

// Defaults of `npm start`, except: the per-caller rate limit is lifted (one
// script plays every provider at once) and the fake CRM takes 200 calls/s, so
// deliveries do not pile up behind its 10/s demo limit.
const SETTINGS: Record<string, string> = {
  AI_MODE: 'recorded',
  LOG_PRETTY: '0',
  LOG_LEVEL: 'info',
  RATE_LIMIT_PER_SEC: '100000',
  RATE_LIMIT_BURST: '100000',
  CRM_RATE_LIMIT_PER_SEC: '100',
  CRM_RATE_LIMIT_BURST: '100',
};

// Request bodies: the plan's fictional people (resends left out); reused in turn,
// each time with a new event id, like the same person writing again.
const plan = makePlan({ seed: Number(values.seed), people: 990, spammers: 10, resendRate: 0 });
const agent = new http.Agent({ keepAlive: true, maxSockets: Math.max(connections, 64) });
let counter = 0;

interface Sample { ms: number; status: number; id?: string }

/** One signed webhook; resolves with its status and how long it took from `dueAt`. */
function sendOne(dueAt: number): Promise<Sample> {
  const w = plan.leads[counter % plan.leads.length];
  const eventId = `bench-${values.seed}-${counter++}`;
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(w.body),
    'x-signature': signatureHeader(config.gateway.secrets[w.source], w.body),
    'x-event-id': eventId,
  };
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/webhooks/${w.source}`, headers, agent }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const ms = performance.now() - dueAt;
        let id: string | undefined;
        try {
          id = res.statusCode === 202 ? JSON.parse(data).id : undefined;
        } catch {}
        resolve({ ms, status: res.statusCode ?? 0, id });
      });
    });
    req.on('error', () => resolve({ ms: performance.now() - dueAt, status: 0 }));
    req.setTimeout(10_000, () => req.destroy());
    req.end(w.body);
  });
}

/** Open loop: requests start on a fixed schedule, whatever the answers do. */
async function steady(perSecond: number, forSeconds: number): Promise<Sample[]> {
  const total = Math.round(perSecond * forSeconds);
  const start = performance.now() + 50;
  const pending: Promise<Sample>[] = [];
  for (let i = 0; i < total; i++) {
    const dueAt = start + (i * 1000) / perSecond;
    const wait = dueAt - performance.now();
    if (wait > 1) await sleep(wait);
    pending.push(sendOne(dueAt));
  }
  return Promise.all(pending);
}

/** Closed loop: `n` requests in flight all the time, for `forSeconds`. */
async function flatOut(n: number, forSeconds: number): Promise<{ samples: Sample[]; elapsed: number }> {
  const samples: Sample[] = [];
  const start = performance.now();
  const end = start + forSeconds * 1000;
  await Promise.all(Array.from({ length: n }, async () => {
    while (performance.now() < end) samples.push(await sendOne(performance.now()));
  }));
  return { samples, elapsed: (performance.now() - start) / 1000 };
}

function stats(samples: Sample[]) {
  const ok = samples.filter((s) => s.status === 202).map((s) => s.ms).sort((a, b) => a - b);
  const at = (p: number) => percentile(ok, p);
  const byStatus: Record<string, number> = {};
  for (const s of samples) byStatus[String(s.status)] = (byStatus[String(s.status)] ?? 0) + 1;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    requests: samples.length, accepted: ok.length, by_status: byStatus,
    ms: { p50: round(at(50)), p95: round(at(95)), p99: round(at(99)), max: round(ok.at(-1) ?? NaN), mean: round(ok.reduce((a, b) => a + b, 0) / (ok.length || 1)) },
  };
}

// ---------------------------------------------------------------------------
const procs: Proc[] = [];
const startNode = nodeStarter(logDir, procs);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(logDir, { recursive: true });
const T0 = Date.now();
console.log(`Bench: warm-up ${warmupSeconds} s, then ${rate} req/s for ${seconds} s, then ${connections} connections flat out for ${seconds} s.`);
console.log(`Layout "${layout}": ${LAYOUTS[layout]}. Fresh Postgres and fake CRM under ${path.relative(process.cwd(), dir)}/.\n`);

const pg = await startEmbeddedPostgres({ dir: path.join(dir, 'pg'), port: Number(values['pg-port']), database: 'lead_intake_bench', log });
const pool = createPool(pg.url, log);
let exitCode = 0;
try {
  await migrate(pool);
  const env = { ...SETTINGS, DATABASE_URL: pg.url, DATA_DIR: dir, CRM_URL: crmUrl, PORT: String(port), HOST: '127.0.0.1' };
  startNode('fake-crm', 'src/cli/fake-crm.ts', env, ['--port', values['crm-port']!, '--rate', '200', '--reset']);
  await waitFor('the fake CRM', async () => (await fetch(`${crmUrl}/_admin/state`)).ok, 30_000);
  startNode('gateway', 'src/main.ts', { ...env, ROLE: layout === 'one' ? 'all' : 'http' });
  if (layout === 'split') startNode('worker', 'src/main.ts', { ...env, ROLE: 'worker' });
  await waitFor('the gateway', async () => (await fetch(`http://127.0.0.1:${port}/ready`)).ok, 60_000);

  console.log(`warm-up (${warmupSeconds} s, not counted)…`);
  await steady(rate, warmupSeconds);
  console.log(`steady: ${rate} req/s for ${seconds} s…`);
  const steadySamples = await steady(rate, seconds);
  await sleep(1_000);
  console.log(`maximum: ${connections} connections for ${seconds} s…`);
  const max = await flatOut(connections, seconds);

  // Every 202 must be a row in the inbox: accepted means stored.
  const ids = [...steadySamples, ...max.samples].filter((s) => s.id).map((s) => s.id!);
  const [{ missing }] = (await pool.query(`select count(*)::int as missing from (select unnest($1::uuid[]) except select id from inbox) m`, [ids])).rows;
  const [{ pg_version }] = (await pool.query(`select current_setting('server_version') as pg_version`)).rows;
  const backlog = (await pool.query(`select kind, count(*)::int as n from jobs where status in ('pending', 'running') group by kind order by kind`)).rows;
  const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
  const serverCount = metricValue(metrics, 'lig_webhook_duration_seconds_count', 'accepted');
  const serverSum = metricValue(metrics, 'lig_webhook_duration_seconds_sum', 'accepted');

  const steadyStats = stats(steadySamples);
  const maxStats = stats(max.samples);
  const result = {
    command, commit: currentCommit(), ran_at: new Date(T0).toISOString(),
    machine: { ...machine(), postgres: pg_version },
    layout,
    setup: `Layout "${layout}": ${LAYOUTS[layout]}. Logs at info to a file, AI replaying recordings, its own embedded Postgres, the fake CRM; the load generator on the same machine. Every request a new signed webhook of a fictional person.`,
    settings: { ...SETTINGS, warmup_seconds: warmupSeconds, rate_per_second: rate, seconds, connections, layout },
    steady: { target_per_second: rate, achieved_per_second: Math.round(steadyStats.accepted / seconds), ...steadyStats },
    maximum: { connections, seconds: Math.round(max.elapsed * 10) / 10, accepted_per_second: Math.round(maxStats.accepted / max.elapsed), ...maxStats },
    server_side: { accepted_counted: serverCount, mean_ms: serverCount ? Math.round((serverSum / serverCount) * 100_000) / 100 : null },
    lost: missing,
    backlog_when_measured: backlog,
  };
  const failed = missing !== 0 || steadyStats.accepted !== steadyStats.requests || maxStats.accepted !== maxStats.requests;

  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date(T0).toISOString().replace(/[-:]/g, '').slice(0, 15);
  const base = path.join(reportsDir, `bench-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(`${base}.md`, renderReport(result));
  const runs = path.join(reportsDir, 'bench-runs.md');
  if (!fs.existsSync(runs)) {
    fs.writeFileSync(runs, '# Bench runs\n\nOne line per `npm run bench`. Each line links to its full report. Same machine for client and server.\n\n| Report | Commit | Layout | Steady rate | p50 | p95 | p99 | Max req/s (connections) | Non-202 | Lost |\n|---|---|---|---|---|---|---|---|---|---|\n');
  }
  const non202 = steadyStats.requests - steadyStats.accepted + maxStats.requests - maxStats.accepted;
  fs.appendFileSync(runs, `| [${path.basename(base)}](${path.basename(base)}.md) | ${result.commit} | ${layout} | ${rate}/s | ${steadyStats.ms.p50} ms | ${steadyStats.ms.p95} ms | ${steadyStats.ms.p99} ms | ${result.maximum.accepted_per_second} (${connections}) | ${non202} | ${missing} |\n`);

  console.log(`\nsteady ${rate} req/s: ${steadyStats.accepted}/${steadyStats.requests} accepted · p50 ${steadyStats.ms.p50} ms · p95 ${steadyStats.ms.p95} ms · p99 ${steadyStats.ms.p99} ms · max ${steadyStats.ms.max} ms`);
  console.log(`maximum (${connections} connections): ${result.maximum.accepted_per_second} req/s accepted · p95 ${maxStats.ms.p95} ms · ${maxStats.accepted}/${maxStats.requests} accepted`);
  console.log(`lost (202 but not in the database): ${missing}`);
  console.log(`\nReport: ${path.relative(process.cwd(), base)}.md (and .json); all runs: reports/bench-runs.md`);
  if (failed) {
    console.error('\nNot every request was accepted and stored: see the report.');
    exitCode = 1;
  }
} catch (err) {
  console.error(`\nbench failed: ${(err as Error).message}`);
  exitCode = 1;
} finally {
  agent.destroy();
  await stopAll(procs);
  await endPool(pool);
  await pg.stop();
}
process.exit(exitCode);

function metricValue(text: string, name: string, outcome: string): number {
  return text.split('\n')
    .filter((l) => l.startsWith(`${name}{`) && l.includes(`outcome="${outcome}"`))
    .reduce((n, l) => n + Number(l.split(' ').at(-1)), 0);
}

type Result = Record<string, any>;

function renderReport(r: Result): string {
  const m = r.machine;
  const s = r.steady;
  const x = r.maximum;
  return `# Gateway bench

- Command: \`${r.command}\`
- Commit: \`${r.commit}\`
- Ran at: ${r.ran_at}
- Machine: ${m.cpu}, ${m.cpus} logical CPUs, ${m.memory_gb} GB RAM, ${m.os}, Node ${m.node}, Postgres ${m.postgres}

## Setup

${r.setup}

What is measured: \`POST /webhooks/:source\`, from the request to the \`202\`. In that time the gateway checks the HMAC signature and the
rate limit, and stores the raw webhook and its job in Postgres in one transaction (the "store before answering" rule). The workers
run at the same time, on the same machine and database, processing what arrives.

Settings different from the defaults: per-caller rate limit lifted to ${r.settings.RATE_LIMIT_PER_SEC}/s (one script plays every provider);
CRM calls ${r.settings.CRM_RATE_LIMIT_PER_SEC}/s (the fake CRM takes 200/s here).

## Results

| | Steady load | Maximum |
|---|---|---|
| How | ${s.target_per_second} req/s on a fixed schedule for ${r.settings.seconds} s | ${x.connections} requests in flight, ${x.seconds} s |
| Requests | ${s.requests} | ${x.requests} |
| Accepted (202) | ${s.accepted} | ${x.accepted} |
| **Throughput** | ${s.achieved_per_second} req/s | **${x.accepted_per_second} req/s** |
| p50 | ${s.ms.p50} ms | ${x.ms.p50} ms |
| **p95** | **${s.ms.p95} ms** | ${x.ms.p95} ms |
| p99 | ${s.ms.p99} ms | ${x.ms.p99} ms |
| Slowest | ${s.ms.max} ms | ${x.ms.max} ms |
| Answers | ${Object.entries(s.by_status).map(([k, v]) => `${k}: ${v}`).join(', ')} | ${Object.entries(x.by_status).map(([k, v]) => `${k}: ${v}`).join(', ')} |

- Latency is measured by the client, for accepted requests. At steady load it counts from when each request was **due**, so time spent
  waiting behind a slow answer is included (no "coordinated omission"). At maximum load, requests queue on purpose: its p95 shows
  queueing, not the gateway at rest.
- Server side, the gateway counted ${r.server_side.accepted_counted} accepted webhooks (warm-up included), ${r.server_side.mean_ms} ms on average
  (\`lig_webhook_duration_seconds\` on /metrics).
- **Lost: ${r.lost}.** Every \`202\` was checked against the database.
- Jobs still queued when the bench ended (the workers catch up afterwards): ${r.backlog_when_measured.map((b: { kind: string; n: number }) => `${b.kind} ${b.n}`).join(', ') || 'none'}.

Numbers are for this machine, with the client on it too. Raw numbers: the \`.json\` file next to this one.
`;
}
