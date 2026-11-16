// npm run replay                 lists the dead-letter, then sends every dead job back to the queue
// npm run replay -- --list       only lists it
// npm run replay -- 12 15        sends back only jobs 12 and 15
// npm run replay -- --kind deliver_crm
// Talks to the running gateway (GET /dead-letter, POST /replay) with ADMIN_TOKEN.
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { loadDotEnv } from '../env.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { list: { type: 'boolean', default: false }, kind: { type: 'string' }, url: { type: 'string' } },
});
loadDotEnv();
const config = loadConfig();
const base = values.url ?? `http://127.0.0.1:${config.port}`;
const headers = { authorization: `Bearer ${config.admin.token}`, 'content-type': 'application/json' };

interface DeadJob { id: string; kind: string; attempts: number; last_error: string | null; failed_at: string; replays: number }

async function call(path: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers });
  } catch {
    console.error(`The gateway is not answering at ${base}. Start it with: npm run dev`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

const dead = (await call(`/dead-letter${values.kind ? `?kind=${encodeURIComponent(values.kind)}` : ''}`)) as { count: number; jobs: DeadJob[] };
if (dead.count === 0) {
  console.log('The dead-letter is empty: nothing to replay.');
  process.exit(0);
}
console.log(`Dead-letter: ${dead.count} job(s)`);
for (const j of dead.jobs) {
  const replays = j.replays ? `, replayed ${j.replays}x before` : '';
  console.log(`  #${j.id}  ${j.kind.padEnd(12)} ${j.attempts} attempts${replays}  last error: ${j.last_error ?? '-'}`);
}
if (values.list) process.exit(0);

const body = positionals.length ? { ids: positionals } : { all: true, kind: values.kind };
const result = (await call('/replay', { method: 'POST', body: JSON.stringify(body) })) as { replayed: number; jobs: DeadJob[] };
console.log(`\nReplayed ${result.replayed} job(s): ${result.jobs.map((j) => `#${j.id}`).join(', ') || '-'}. They are back in the queue, with their attempts reset.`);
