// npm run demo: the whole pipeline so far, on a fresh database, with no setup.
// Sends the Juniper Lane Realty webhooks through the real gateway (signed, in
// process), lets the workers process and classify them, and prints what happened.
// The AI answers are real ones recorded earlier (npm run ai:record): no key, no cost.
import fs from 'node:fs/promises';
import path from 'node:path';
import { RecordedClassifier } from '../ai/classifier.ts';
import { loadPriceList } from '../ai/pricing.ts';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { createPool, endPool } from '../db/database.ts';
import { startEmbeddedPostgres } from '../db/embedded.ts';
import { migrate } from '../db/migrate.ts';
import { demoScript, loadFixture } from '../fixtures.ts';
import { signatureHeader } from '../gateway/signature.ts';
import { CLASSIFY_JOB, makeClassifyHandler } from '../leads/classify-job.ts';
import { processLead } from '../leads/process.ts';
import { createLogger } from '../logger.ts';
import { drain } from '../queue/worker.ts';
import { ROUTES, type Route } from '../routing/rules.ts';

const SOURCE_LABEL: Record<string, string> = { form: 'form', email: 'email', whatsapp: 'WhatsApp', portal: 'portal' };
const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const BUDGET_LABEL: Record<string, string> = {
  not_stated: 'no budget',
  rent_under_3k_month: '<$3k/mo',
  rent_3k_plus_month: '$3k+/mo',
  buy_under_500k: '<$500k',
  buy_500k_to_1m: '$500k–1M',
  buy_over_1m: '$1M+',
};
const usd = (n: number) => '$' + n.toFixed(6);
const clip = (s: string | null, n: number) => (!s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ');

// The demo never touches DATABASE_URL: it always uses its own throwaway database.
const config = loadConfig({ ...process.env, DATABASE_URL: '' });
// Only real errors are logged: the demo prints its own report.
const log = createLogger({ logLevel: 'error', logPretty: false });
const dir = path.join(config.dataDir, 'demo-pg');
await fs.rm(dir, { recursive: true, force: true });

console.log(bold('Lead Intake Gateway demo') + dim('  (so far: intake, normalisation, identity, AI classification, routing)'));
console.log(dim(`Juniper Lane Realty, a fictional agency. Fresh database in ${path.relative(process.cwd(), dir)}/.\n`));

const server = await startEmbeddedPostgres({ dir, port: config.embeddedPgPort + 1, database: 'lead_intake_demo', log });
const pool = createPool(server.url, log);
try {
  await migrate(pool);
  const app = buildApp({ pool, log, gateway: config.gateway });

  // 1. Webhooks
  console.log(bold('1. Webhooks arrive at POST /webhooks/:source'));
  const firstIdOf = new Map<string, number>();
  let accepted = 0, duplicates = 0, broken = 0;
  const script = demoScript();
  for (const [i, step] of script.entries()) {
    const { body } = loadFixture(step.source, step.fixture);
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/${step.source}`,
      payload: body,
      headers: { 'content-type': 'application/json', 'x-signature': signatureHeader(config.gateway.secrets[step.source], body) },
    });
    const answer = res.json();
    let outcome: string;
    if (res.statusCode === 202 && answer.duplicate) {
      duplicates++;
      outcome = `202 same id as #${firstIdOf.get(answer.id)}: not stored again`;
    } else if (res.statusCode === 202) {
      accepted++;
      firstIdOf.set(answer.id, i + 1);
      outcome = '202 stored and queued';
    } else {
      broken++;
      outcome = `${res.statusCode} ${answer.error}: kept for a human, not queued`;
    }
    console.log(`  ${String(i + 1).padStart(2)}  ${SOURCE_LABEL[step.source].padEnd(8)}  ${step.fixture.padEnd(9)}  ${outcome.padEnd(42)} ${dim(step.note)}`);
  }
  await app.close();
  console.log(`  → ${script.length} webhooks: ${accepted} new leads queued, ${duplicates} resend recognised, ${broken} broken payload kept\n`);

  // 2. Workers
  const prices = loadPriceList();
  const classifier = new RecordedClassifier();
  // One loop, so leads are processed in arrival order and the story is the same
  // every run: Dan B is a contact of his own until Daniel's portal lead links them.
  // With several loops the final contacts are the same, but Daniel's portal lead
  // may come first, and then Dan B is never a separate contact to merge.
  const counts = await drain({ pool, log, kind: 'process', handler: processLead, concurrency: 1 });
  const classified = await drain({ pool, log, kind: CLASSIFY_JOB, handler: makeClassifyHandler({ classifier, prices }), concurrency: 4 });
  console.log(bold('2. Workers take jobs from the Postgres queue (FOR UPDATE SKIP LOCKED)'));
  console.log(`  → "process":  ${counts.done} jobs done, ${counts.retry} retried, ${counts.dead} dead-letter (each one queues a "classify" job)`);
  console.log(`  → "classify": ${classified.done} jobs done, ${classified.retry} retried, ${classified.dead} dead-letter\n`);

  // 3. Identity
  const contacts = (await pool.query<{ id: string; display_name: string | null; leads: number; sources: string[]; emails: string[] | null; phones: string[] | null; merged: string[] | null }>(`
    select c.id, c.display_name,
           (select count(*)::int from leads l where l.contact_id = c.id) as leads,
           (select array_agg(l.source order by l.occurred_at) from leads l where l.contact_id = c.id) as sources,
           (select array_agg(value) from contact_identifiers i where i.contact_id = c.id and kind = 'email') as emails,
           (select array_agg(value) from contact_identifiers i where i.contact_id = c.id and kind = 'phone') as phones,
           (select array_agg(m.display_name) from contacts m where m.merged_into = c.id) as merged
      from contacts c where c.merged_into is null
     order by (select min(occurred_at) from leads l where l.contact_id = c.id)`)).rows;
  const leadCount = contacts.reduce((n, c) => n + c.leads, 0);

  console.log(bold('3. Identity: one person, one contact'));
  for (const c of contacts.filter((c) => new Set(c.sources).size > 1)) {
    const channels = [...new Set(c.sources)].map((s) => SOURCE_LABEL[s]).join(', ');
    console.log(`\n  ${bold(`${c.leads} leads (${channels}) → 1 contact: ${c.display_name}`)}${c.merged ? dim(`  (merged with "${c.merged.join('", "')}")`) : ''}`);
    const leads = (await pool.query<{ phone_raw: string | null; email_raw: string | null }>(
      'select phone_raw, email_raw from leads where contact_id = $1 order by occurred_at', [c.id])).rows;
    // Show how each identifier was written, when the channels wrote it differently.
    const asSent = (label: string, raw: (string | null)[], normalized: string[] | null) => {
      const written = raw.filter((r): r is string => Boolean(r));
      if (written.length > 1 && written.some((w) => !normalized?.includes(w))) {
        console.log(`    ${label} as sent: ${written.map((w) => `"${w}"`).join(' · ')}  →  ${normalized?.join(', ')}`);
      }
    };
    asSent('phone', leads.map((l) => l.phone_raw), c.phones);
    asSent('email', leads.map((l) => l.email_raw), c.emails);
    console.log('    timeline:');
    const events = (await pool.query<{ kind: string; occurred_at: Date; detail: Record<string, any>; message: string | null }>(
      `select e.kind, e.occurred_at, e.detail, l.message from contact_events e left join leads l on l.id = e.lead_id
        where e.contact_id = $1 order by e.occurred_at, e.id`, [c.id])).rows;
    for (const e of events) {
      const at = time.format(e.occurred_at);
      if (e.kind === 'lead') {
        const how = e.detail.new_contact ? 'new contact' : `matched by ${e.detail.matched_by.join(' + ')}`;
        console.log(`      ${at}  ${SOURCE_LABEL[e.detail.source].padEnd(8)}  ${how.padEnd(24)}  ${dim(`"${clip(e.message, 60)}"`)}`);
      } else if (e.kind === 'routed') {
        console.log(`      ${at}  ${''.padEnd(8)}  ${'routed'.padEnd(24)}  ${dim('→ ' + ROUTES[e.detail.route as Route])}`);
      } else if (e.kind === 'identifier_added') {
        console.log(`      ${at}  ${''.padEnd(8)}  ${`+ ${e.detail.kind} added`.padEnd(24)}  ${dim(e.detail.value)}`);
      } else {
        console.log(`      ${at}  ${''.padEnd(8)}  ${'merged'.padEnd(24)}  ${dim(`absorbed "${e.detail.absorbed_name}": ${e.detail.reason}`)}`);
      }
    }
  }

  console.log(`\n  ${bold(`All contacts: ${leadCount} leads → ${contacts.length} contacts`)}`);
  for (const c of contacts) {
    const ids = [...(c.emails ?? []), ...(c.phones ?? [])].join(' · ') || 'no email or phone';
    console.log(`    ${clip(c.display_name ?? '(no name)', 22).padEnd(22)}  ${String(c.leads).padStart(2)} lead${c.leads > 1 ? 's' : ' '}  ${dim(ids)}`);
  }
  const sameName = contacts.filter((c, _i, all) => all.filter((o) => o.display_name === c.display_name).length > 1);
  if (sameName.length) {
    console.log(dim(`\n  "${sameName[0].display_name}" appears ${sameName.length} times on purpose: same name, different email and phone. A name alone never merges two people.`));
  }

  // 4. AI classifies, code routes
  console.log('\n' + bold('4. The AI describes each lead; the code decides where it goes'));
  console.log(dim(`  ${classifier.model}: real answers recorded on ${classifier.recordedOn() ?? 'an earlier run'}, replayed now.`));
  console.log(dim('  Confidence below 0.70, a refusal or an invalid answer twice → manual review.\n'));
  const routed = (
    await pool.query<{
      source: string; name: string | null; status: string; intent: string | null; urgency: string | null;
      budget_band: string | null; language: string | null; confidence: string | null; evidence: string | null;
      route: Route; reason: string;
    }>(`
      select l.source, l.name, c.status, c.intent, c.urgency, c.budget_band, c.language, c.confidence, c.evidence, r.route, r.reason
        from leads l
        join lead_classifications c on c.lead_id = l.id
        join lead_routes r on r.lead_id = l.id
        join inbox i on i.id = l.inbox_id
       order by i.received_at, l.id`)
  ).rows;
  console.log(dim(`  ${'#'.padStart(2)}  ${'channel'.padEnd(8)}  ${'name'.padEnd(16)}  ${'intent'.padEnd(6)} ${'urgency'.padEnd(7)} ${'budget'.padEnd(9)} lang conf  route`));
  for (const [n, r] of routed.entries()) {
    const said = r.intent
      ? `${r.intent.padEnd(6)} ${r.urgency!.padEnd(7)} ${BUDGET_LABEL[r.budget_band!].padEnd(9)} ${r.language!.padEnd(4)} ${Number(r.confidence).toFixed(2)}`
      : 'no usable answer'.padEnd(34);
    const name = clip(r.name ?? '(no name)', 16).padEnd(16);
    console.log(`  ${String(n + 1).padStart(2)}  ${SOURCE_LABEL[r.source].padEnd(8)}  ${name}  ${said}  → ${bold(ROUTES[r.route])}`);
    console.log(`      ${dim('why: ' + r.reason)}`);
    if (r.evidence) console.log(`      ${dim('AI evidence: ' + r.evidence)}`);
  }
  const byRoute = new Map<Route, number>();
  for (const r of routed) byRoute.set(r.route, (byRoute.get(r.route) ?? 0) + 1);
  console.log(`\n  ${bold(`${routed.length} leads routed:`)} ${[...byRoute].map(([route, n]) => `${ROUTES[route]} ${n}`).join(' · ')}`);

  // 5. Cost
  const cost = (
    await pool.query<{ calls: number; input: number; output: number; usd: string }>(
      'select count(*)::int as calls, sum(input_tokens)::int as input, sum(output_tokens)::int as output, sum(cost_usd) as usd from ai_calls',
    )
  ).rows[0];
  const price = prices.models[classifier.model];
  console.log('\n' + bold('5. What the AI cost'));
  console.log(
    `  ${cost.calls} calls to ${classifier.model}: ${cost.input.toLocaleString('en-US')} input + ${cost.output.toLocaleString('en-US')} output tokens = ` +
      bold(usd(Number(cost.usd))) + `  (${usd(Number(cost.usd) / Math.max(cost.calls, 1))} per lead on average)`,
  );
  console.log(dim('  That is what these answers cost when they were recorded; replaying them now costs $0.'));
  console.log(dim(`  Price: $${price.input_usd_per_mtok.toFixed(2)} input / $${price.output_usd_per_mtok.toFixed(2)} output per million tokens (config/pricing.json, checked ${prices.checkedOn}).`));
} finally {
  await endPool(pool);
  await server.stop();
}
