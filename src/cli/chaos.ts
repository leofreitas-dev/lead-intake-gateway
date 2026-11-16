// npm run chaos [-- --seed 1 --people 120 --down-sec 60 --fault-sec 15]
//
// The chaos test, end to end, with real processes:
//   - its own fresh Postgres (data/chaos/pg), the fake CRM, the gateway, and a
//     second worker-only process, all sharing one queue;
//   - a burst of signed webhooks over the 4 channels, with resends of the same
//     webhook (same event id, or same body);
//   - the CRM down for 60 s, then answering 429, then 500;
//   - kill -9 of the worker process while it holds a delivery in flight;
//   - then it waits for the queue to drain and checks the result against the
//     plan (src/chaos/plan.ts): leads lost, contacts duplicated in the CRM, ...
// The report goes to reports/, with the command and the commit that made it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { makePlan, type Plan } from '../chaos/plan.ts';
import { loadConfig } from '../config.ts';
import { createPool, endPool } from '../db/database.ts';
import { startEmbeddedPostgres } from '../db/embedded.ts';
import { migrate } from '../db/migrate.ts';
import { signatureHeader } from '../gateway/signature.ts';
import { createLogger } from '../logger.ts';
import { currentCommit, nodeStarter, type Proc, sleep, stopAll, waitFor } from './support.ts';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '1' },
    people: { type: 'string', default: '120' },
    'down-sec': { type: 'string', default: '60' },
    'fault-sec': { type: 'string', default: '15' },
    'pg-port': { type: 'string', default: '25438' },
    'http-port': { type: 'string', default: '3293' },
    'crm-port': { type: 'string', default: '4013' },
  },
});
const seed = Number(values.seed);
const downSec = Number(values['down-sec']);
const faultSec = Number(values['fault-sec']);
const command = `npm run chaos${process.argv.length > 2 ? ` -- ${process.argv.slice(2).join(' ')}` : ''}`;

// The chaos run never touches the gateway's own database or settings.
const config = loadConfig({ ...process.env, DATABASE_URL: '' });
const dir = path.join(config.dataDir, 'chaos');
const logDir = path.join(dir, 'logs');
const reportsDir = path.resolve('reports');
const log = createLogger({ logLevel: 'error', logPretty: false });
const T0 = Date.now();
const seconds = (at = Date.now()) => Math.round((at - T0) / 100) / 10;
const timeline: { at: number; what: string }[] = [];
const mark = (what: string) => {
  timeline.push({ at: seconds(), what });
  console.log(`[${seconds().toFixed(1).padStart(6)} s] ${what}`);
};

const plan = makePlan({ seed, people: Number(values.people) });
const pgPort = Number(values['pg-port']);
const gatewayUrl = `http://127.0.0.1:${values['http-port']}`;
const crmUrl = `http://127.0.0.1:${values['crm-port']}`;

// Settings of the processes under test. Defaults, except: a 10 s lease so a
// killed worker's delivery is taken over quickly; 4 CRM calls/s per process
// (2 processes = 8/s, under the fake CRM's 10/s); and the gateway's own
// per-caller limit raised, because one script plays every provider at once.
const SETTINGS: Record<string, string> = {
  AI_MODE: 'recorded',
  LOG_PRETTY: '0',
  LOG_LEVEL: 'info',
  DELIVERY_LEASE_MS: '10000',
  CRM_RATE_LIMIT_PER_SEC: '4',
  CRM_RATE_LIMIT_BURST: '4',
  RATE_LIMIT_PER_SEC: '500',
  RATE_LIMIT_BURST: '1000',
};

const procs: Proc[] = [];
const startNode = nodeStarter(logDir, procs);

const crmMode = (mode: string, slowMs?: number) =>
  fetch(`${crmUrl}/_admin/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, slowMs }) });

interface SendResult { n: number; resend: boolean; status: number; id?: string; duplicate?: boolean; tries: number }

/** Sends every planned webhook, 16 at a time, retrying like a provider: on no answer, 429 or 5xx. */
async function sendAll(p: Plan): Promise<{ results: SendResult[]; requests: number }> {
  const results: SendResult[] = [];
  let requests = 0;
  let next = 0;
  const one = async (w: Plan['sends'][number]): Promise<SendResult> => {
    for (let tries = 1; tries <= 30; tries++) {
      requests++;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-signature': signatureHeader(config.gateway.secrets[w.source], w.body),
      };
      if (w.eventId) headers['x-event-id'] = w.eventId;
      try {
        const res = await fetch(`${gatewayUrl}/webhooks/${w.source}`, { method: 'POST', headers, body: w.body, signal: AbortSignal.timeout(10_000) });
        if (res.status === 200 || res.status === 202) {
          const body = (await res.json()) as { id: string; duplicate: boolean };
          return { n: w.n, resend: w.resendOf !== undefined, status: res.status, id: body.id, duplicate: body.duplicate, tries };
        }
        if (res.status !== 429 && res.status < 500) return { n: w.n, resend: w.resendOf !== undefined, status: res.status, tries };
        await sleep(Number(res.headers.get('retry-after') ?? 0) * 1000 || 200 * tries);
      } catch {
        await sleep(200 * tries);
      }
    }
    return { n: w.n, resend: w.resendOf !== undefined, status: 0, tries: 30 };
  };
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < p.sends.length) results.push(await one(p.sends[next++]));
    }),
  );
  return { results, requests };
}

// ---------------------------------------------------------------------------
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(logDir, { recursive: true });
console.log(`Chaos run, seed ${seed}: ${plan.sends.length} webhooks (${plan.leads.length} leads + ${plan.sends.length - plan.leads.length} resends) from ${plan.groups.length} contacts to be.`);
console.log(`Fresh Postgres, fake CRM, gateway and a worker process under ${path.relative(process.cwd(), dir)}/ (logs in logs/).\n`);

const pg = await startEmbeddedPostgres({ dir: path.join(dir, 'pg'), port: pgPort, database: 'lead_intake_chaos', log });
const pool = createPool(pg.url, log);
let exitCode = 0;
try {
  await migrate(pool);
  const env = { ...SETTINGS, DATABASE_URL: pg.url, DATA_DIR: dir, CRM_URL: crmUrl, PORT: values['http-port']!, HOST: '127.0.0.1' };
  const crm = startNode('fake-crm', 'src/cli/fake-crm.ts', env, ['--port', values['crm-port']!, '--rate', '10', '--reset']);
  await waitFor('the fake CRM', async () => (await fetch(`${crmUrl}/_admin/state`)).ok, 30_000);
  const gateway = startNode('gateway', 'src/main.ts', { ...env, ROLE: 'all' });
  let worker = startNode('worker-1', 'src/main.ts', { ...env, ROLE: 'worker' });
  await waitFor('the gateway', async () => (await fetch(`${gatewayUrl}/ready`)).ok, 60_000);
  await waitFor('the worker process', async () => fs.readFileSync(worker.logFile, 'utf8').includes('"msg":"ready: worker-only'), 60_000);
  mark(`started: fake CRM (pid ${crm.pid}), gateway (pid ${gateway.pid}), worker-1 (pid ${worker.pid})`);

  // 1. The burst, with the CRM failing underneath it.
  const burstStart = Date.now();
  mark(`burst: sending ${plan.sends.length} webhooks, 16 at a time`);
  const sending = sendAll(plan).then((r) => {
    mark(`burst sent: ${r.requests} HTTP requests in ${((Date.now() - burstStart) / 1000).toFixed(1)} s`);
    return r;
  });
  await sleep(3_000);
  await crmMode('down');
  mark(`CRM down (drops every connection) for ${downSec} s`);
  await sleep(downSec * 1000);
  await crmMode('429');
  mark(`CRM answers 429 (rate limited) for ${faultSec} s`);
  await sleep(faultSec * 1000);
  await crmMode('500');
  mark(`CRM answers 500 for ${faultSec} s`);
  await sleep(faultSec * 1000);

  // 2. kill -9 while a delivery is in flight: the CRM saves, then answers slowly.
  await crmMode('slow', 5_000);
  mark('CRM slow (saves, answers after 5 s): waiting for worker-1 to hold a delivery');
  const workerId = `${os.hostname()}:${worker.pid}`;

  const victim = await waitFor(
    'a delivery held by worker-1',
    async () => (await pool.query(`select id, payload->>'contact_id' as contact_id, attempts from jobs where kind = 'deliver_crm' and status = 'running' and locked_by = $1 limit 1`, [workerId])).rows[0],
    60_000,
    50,
  );
  const heldSince = Date.now(); // worker-1 claimed it within the last 50 ms
  await sleep(1_000); // the call is out: the CRM has it, the answer has not come back
  const killedAt = Date.now();
  worker.child.kill('SIGKILL');
  await worker.exited;
  mark(`kill -9 worker-1 (pid ${worker.pid}) while it held delivery job #${victim.id}`);
  await crmMode('ok');
  const crmBackAt = Date.now();
  mark('CRM ok again');
  worker = startNode('worker-2', 'src/main.ts', { ...env, ROLE: 'worker' });
  mark(`worker-2 started (pid ${worker.pid})`);

  // 3. Wait for every job to be done (or dead).
  const sent = await sending;
  const drainedAt = await waitFor(
    'the queue to drain',
    async () => {
      const { rows } = await pool.query(`select count(*)::int as n from jobs where status in ('pending', 'running')`);
      return rows[0].n === 0 && Date.now();
    },
    15 * 60_000,
    250,
  );
  mark('queue drained: no job pending or running');

  // 4. Measure.
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
  const crmState = (await (await fetch(`${crmUrl}/_admin/state`)).json()) as { contacts: { id: string; external_id: string; merged_into: string | null; version: number; data: { emails: string[]; phones: string[]; leadCount: number; name: string } }[] };
  const crmCalls = (await (await fetch(`${crmUrl}/_admin/calls`)).json()) as { at: string; external_id?: string; status: number | string }[];

  const accepted = sent.results.filter((r) => r.id);
  const acceptedIds = new Set(accepted.map((r) => r.id!));
  const idOfOriginal = new Map(accepted.filter((r) => !r.resend).map((r) => [r.n, r.id!]));
  const resendsWithOtherId = accepted.filter((r) => r.resend && idOfOriginal.get(r.n) !== r.id).length;
  const [{ inbox }] = await q<{ inbox: number }>(`select count(*)::int as inbox from inbox`);
  const [{ leads }] = await q<{ leads: number }>(`select count(*)::int as leads from leads`);
  const missingInInbox = (await q<{ id: string }>(`select unnest($1::uuid[]) as id except select id from inbox`, [[...acceptedIds]])).length;
  const [{ contacts }] = await q<{ contacts: number }>(`select count(*)::int as contacts from contacts where merged_into is null`);
  const jobs = await q<{ kind: string; status: string; n: number; retries: number }>(
    `select kind, status, count(*)::int as n, sum(greatest(attempts - 1, 0))::int as retries from jobs group by kind, status order by kind, status`,
  );
  const dead = jobs.filter((j) => j.status === 'dead').reduce((n, j) => n + j.n, 0);
  const retriesOf = (kind: string) => jobs.filter((j) => j.kind === kind).reduce((n, j) => n + j.retries, 0);

  // Each expected contact must be in the CRM exactly once (and spam not at all).
  const active = crmState.contacts.filter((c) => c.merged_into === null);
  const recordsPerGroup = new Map<number, number>();
  let strangers = 0;
  let mixed = 0;
  let outOfDate = 0;
  for (const record of active) {
    const keys = [...record.data.emails.map((e) => `e:${e}`), ...record.data.phones.map((p) => `p:${p}`)];
    const groups = new Set(keys.map((k) => plan.groupOfKey.get(k)).filter((g) => g !== undefined));
    if (groups.size === 0) strangers++;
    if (groups.size > 1) mixed++;
    for (const g of groups) recordsPerGroup.set(g!, (recordsPerGroup.get(g!) ?? 0) + 1);
    if (groups.size === 1) {
      const group = plan.groups[[...groups][0]!];
      if (record.data.leadCount !== group.leadCount || keys.length !== group.keys.length) outOfDate++;
    }
  }
  const expectedInCrm = plan.groups.filter((g) => g.delivered);
  const missingFromCrm = expectedInCrm.filter((g) => !recordsPerGroup.has(g.id)).length;
  const duplicatedInCrm = [...recordsPerGroup.values()].reduce((n, c) => n + Math.max(0, c - 1), 0);
  const spamInCrm = plan.groups.filter((g) => !g.delivered && recordsPerGroup.has(g.id)).length;
  const callsByStatus: Record<string, number> = {};
  for (const c of crmCalls) callsByStatus[String(c.status)] = (callsByStatus[String(c.status)] ?? 0) + 1;
  const victimExternal = `lig_contact_${String(victim.contact_id).replaceAll('-', '')}`;
  // Calls for the killed delivery's contact made while worker-1 held it: the CRM got it, the answer never came back.
  const victimCallsBeforeKill = crmCalls.filter((c) => c.external_id === victimExternal && Date.parse(c.at) >= heldSince - 1_000 && Date.parse(c.at) <= killedAt).length;
  const [victimJob] = await q<{ status: string; attempts: number; locked_by: string }>(`select status, attempts, locked_by from jobs where id = $1`, [victim.id]);
  const breakerOpened = procs.reduce((n, p) => n + (fs.readFileSync(p.logFile, 'utf8').match(/circuit breaker OPEN/g)?.length ?? 0), 0);

  const lost = (acceptedIds.size - inbox) + missingInInbox + (plan.leads.length - leads) + missingFromCrm;
  const duplicated = duplicatedInCrm + mixed + strangers + spamInCrm;
  const ok = lost === 0 && duplicated === 0 && contacts === plan.groups.length && outOfDate === 0 && dead === 0 && resendsWithOtherId === 0;

  const result = {
    command, seed, commit: currentCommit(), ran_at: new Date(T0).toISOString(),
    machine: `${os.cpus().length} CPUs, ${os.platform()} ${os.release()}, Node ${process.version}`,
    settings: { ...SETTINGS, CRM_DOWN_SEC: downSec, CRM_429_SEC: faultSec, CRM_500_SEC: faultSec },
    plan: { webhooks: plan.sends.length, leads: plan.leads.length, resends: plan.sends.length - plan.leads.length, contacts: plan.groups.length, contacts_for_crm: expectedInCrm.length },
    sent: { http_requests: sent.requests, accepted_unique: acceptedIds.size, recognised_as_duplicate: accepted.filter((r) => r.duplicate).length, resends_given_another_id: resendsWithOtherId, gave_up: sent.results.filter((r) => !r.id).length },
    stored: { inbox, leads, contacts },
    crm: { active_records: active.length, records: crmState.contacts.length, calls: crmCalls.length, calls_by_status: callsByStatus },
    lost: { total: lost, accepted_but_not_stored: acceptedIds.size - inbox + missingInInbox, leads_missing: plan.leads.length - leads, contacts_missing_from_crm: missingFromCrm },
    duplicated: { total: duplicated, extra_crm_records: duplicatedInCrm, records_mixing_two_contacts: mixed, records_matching_no_contact: strangers, spam_in_crm: spamInCrm },
    out_of_date_in_crm: outOfDate,
    dead_letter: dead,
    retries: { process: retriesOf('process'), classify: retriesOf('classify'), deliver_crm: retriesOf('deliver_crm') },
    jobs,
    circuit_breaker_opened: breakerOpened,
    kill: { job: victim.id, crm_calls_for_it_before_kill: victimCallsBeforeKill, final_status: victimJob.status, final_attempts: victimJob.attempts, crm_records_for_it: crmState.contacts.filter((c) => c.external_id === victimExternal).length },
    seconds: { burst_to_drained: (drainedAt - burstStart) / 1000, crm_back_to_drained: (drainedAt - crmBackAt) / 1000 },
    timeline,
    verdict: ok ? 'PASS' : 'FAIL',
  };

  // 5. Report.
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date(T0).toISOString().replace(/[-:]/g, '').slice(0, 15);
  const base = path.join(reportsDir, `chaos-seed${seed}-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(`${base}.md`, renderReport(result));
  const runs = path.join(reportsDir, 'chaos-runs.md');
  if (!fs.existsSync(runs)) {
    fs.writeFileSync(runs, '# Chaos runs\n\nOne line per `npm run chaos`. Each line links to its full report.\n\n| Report | Commit | Seed | Leads | Lost | Duplicated in CRM | Out of date | Dead-letter | Delivery retries | Breaker opened | CRM back → drained | Verdict |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n');
  }
  fs.appendFileSync(runs, `| [${path.basename(base)}](${path.basename(base)}.md) | ${result.commit} | ${seed} | ${leads} | ${lost} | ${duplicated} | ${outOfDate} | ${dead} | ${result.retries.deliver_crm} | ${breakerOpened}× | ${result.seconds.crm_back_to_drained.toFixed(1)} s | ${result.verdict} |\n`);

  console.log(`\n${renderSummary(result)}`);
  console.log(`\nReport: ${path.relative(process.cwd(), base)}.md (and .json); all runs: reports/chaos-runs.md`);
  if (!ok) exitCode = 1;
} catch (err) {
  console.error(`\nchaos run failed: ${(err as Error).message}`);
  exitCode = 1;
} finally {
  await stopAll(procs);
  await endPool(pool);
  await pg.stop();
}
process.exit(exitCode);

type Result = Record<string, any>;

function renderSummary(r: Result): string {
  const line = (label: string, value: string | number, check?: boolean) => `  ${label.padEnd(34)} ${String(value).padEnd(10)}${check === undefined ? '' : check ? 'ok' : 'NOT OK'}`;
  return [
    `Chaos result: ${r.verdict}`,
    line('webhooks sent (with resends)', r.plan.webhooks),
    line('unique leads accepted', r.sent.accepted_unique, r.sent.accepted_unique === r.plan.leads),
    line('resends recognised (duplicate)', r.sent.recognised_as_duplicate, r.sent.recognised_as_duplicate === r.plan.resends),
    line('leads stored', r.stored.leads, r.stored.leads === r.plan.leads),
    line('contacts (identity)', `${r.stored.contacts}/${r.plan.contacts}`, r.stored.contacts === r.plan.contacts),
    line('contacts in the CRM', `${r.crm.active_records}/${r.plan.contacts_for_crm}`, r.crm.active_records === r.plan.contacts_for_crm),
    line('LOST', r.lost.total, r.lost.total === 0),
    line('DUPLICATED in the CRM', r.duplicated.total, r.duplicated.total === 0),
    line('out of date in the CRM', r.out_of_date_in_crm, r.out_of_date_in_crm === 0),
    line('dead-letter', r.dead_letter, r.dead_letter === 0),
    line('delivery retries', r.retries.deliver_crm),
    line('circuit breaker opened', `${r.circuit_breaker_opened}x`),
    line('killed delivery: CRM records', r.kill.crm_records_for_it, r.kill.crm_records_for_it === 1),
    line('time: CRM back → queue drained', `${r.seconds.crm_back_to_drained.toFixed(1)} s`),
  ].join('\n');
}

function renderReport(r: Result): string {
  const row = (what: string, expected: string | number, measured: string | number, ok?: boolean) => `| ${what} | ${expected} | ${measured} | ${ok === undefined ? '' : ok ? 'ok' : '**NOT OK**'} |`;
  const s = r.settings;
  return `# Chaos run: ${r.verdict}

- Command: \`${r.command}\`
- Commit: \`${r.commit}\`
- Ran at: ${r.ran_at}
- Machine: ${r.machine}

## What was done

${r.plan.webhooks} signed webhooks over the 4 channels (form, email, WhatsApp, portal): ${r.plan.leads} different leads plus ${r.plan.resends} resends of the same webhook (same event id, or same body), sent 16 at a time. Fictional people only (\`.example.test\` emails, 555-01xx phones). Running: the gateway (HTTP + workers) and a second worker-only process, on one Postgres queue, delivering to the fake CRM.

| Time | Event |
|---|---|
${r.timeline.map((t: { at: number; what: string }) => `| ${t.at.toFixed(1)} s | ${t.what} |`).join('\n')}

Settings different from the defaults: lease ${s.DELIVERY_LEASE_MS} ms; ${s.CRM_RATE_LIMIT_PER_SEC} CRM calls/s per process; gateway rate limit ${s.RATE_LIMIT_PER_SEC}/s (one script plays every provider). Everything else as in \`.env.example\` (10 attempts, backoff 1 s × 2ⁿ with jitter, breaker after 5 failures, 15 s open).

## Result

| | Expected | Measured | |
|---|---|---|---|
${[
  row('Unique leads accepted (202)', r.plan.leads, r.sent.accepted_unique, r.sent.accepted_unique === r.plan.leads),
  row('Resends recognised as duplicates', r.plan.resends, r.sent.recognised_as_duplicate, r.sent.recognised_as_duplicate === r.plan.resends),
  row('Resends that got a different id', 0, r.sent.resends_given_another_id, r.sent.resends_given_another_id === 0),
  row('Leads stored', r.plan.leads, r.stored.leads, r.stored.leads === r.plan.leads),
  row('Contacts after identity resolution', r.plan.contacts, r.stored.contacts, r.stored.contacts === r.plan.contacts),
  row('Contacts in the CRM (spam excluded)', r.plan.contacts_for_crm, r.crm.active_records, r.crm.active_records === r.plan.contacts_for_crm),
  row('**Lost**', 0, r.lost.total, r.lost.total === 0),
  row('**Duplicated in the CRM**', 0, r.duplicated.total, r.duplicated.total === 0),
  row('CRM records out of date', 0, r.out_of_date_in_crm, r.out_of_date_in_crm === 0),
  row('Dead-letter', 0, r.dead_letter, r.dead_letter === 0),
].join('\n')}

Lost = accepted but not stored (${r.lost.accepted_but_not_stored}) + planned leads missing (${r.lost.leads_missing}) + contacts missing from the CRM (${r.lost.contacts_missing_from_crm}).
Duplicated = extra CRM records for one contact (${r.duplicated.extra_crm_records}) + records mixing two contacts (${r.duplicated.records_mixing_two_contacts}) + records matching no contact (${r.duplicated.records_matching_no_contact}) + spam in the CRM (${r.duplicated.spam_in_crm}).

## How it got there

| | |
|---|---|
| HTTP requests sent (with provider retries) | ${r.sent.http_requests} |
| Retries: process / classify / deliver_crm | ${r.retries.process} / ${r.retries.classify} / ${r.retries.deliver_crm} |
| CRM calls by answer | ${Object.entries(r.crm.calls_by_status).map(([k, v]) => `${k}: ${v}`).join(', ')} |
| Circuit breaker opened | ${r.circuit_breaker_opened} times (both processes) |
| kill -9 | job #${r.kill.job}: the CRM received ${r.kill.crm_calls_for_it_before_kill} call(s) for that contact while worker-1 held it (saved, answer not yet back); it ended \`${r.kill.final_status}\` after ${r.kill.final_attempts} attempts; CRM records for that contact: ${r.kill.crm_records_for_it} |
| Burst start → queue drained | ${r.seconds.burst_to_drained.toFixed(1)} s |
| CRM back → queue drained | ${r.seconds.crm_back_to_drained.toFixed(1)} s |

Raw numbers: the \`.json\` file next to this one. Logs of each process: \`data/chaos/logs/\` (not kept in git).
`;
}
