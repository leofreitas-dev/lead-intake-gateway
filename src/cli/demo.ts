// npm run demo: the whole pipeline so far, on a fresh database, with no setup.
// Sends the Juniper Lane Realty webhooks through the real gateway (signed, in
// process), lets the worker process them, and prints what happened.
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { createPool } from '../db/database.ts';
import { startEmbeddedPostgres } from '../db/embedded.ts';
import { migrate } from '../db/migrate.ts';
import { demoScript, loadFixture } from '../fixtures.ts';
import { signatureHeader } from '../gateway/signature.ts';
import { processLead } from '../leads/process.ts';
import { createLogger } from '../logger.ts';
import { drain } from '../queue/worker.ts';

const SOURCE_LABEL: Record<string, string> = { form: 'form', email: 'email', whatsapp: 'WhatsApp', portal: 'portal' };
const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const clip = (s: string | null, n: number) => (!s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ');

// The demo never touches DATABASE_URL: it always uses its own throwaway database.
const config = loadConfig({ ...process.env, DATABASE_URL: '' });
// Only real errors are logged: the demo prints its own report.
const log = createLogger({ logLevel: 'error', logPretty: false });
const dir = path.join(config.dataDir, 'demo-pg');
await fs.rm(dir, { recursive: true, force: true });

console.log(bold('Lead Intake Gateway demo') + dim('  (so far: intake, normalisation, identity)'));
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

  // 2. Worker
  const counts = await drain({ pool, log, kind: 'process', handler: processLead, concurrency: 4 });
  console.log(bold('2. The worker takes each "process" job from the Postgres queue (FOR UPDATE SKIP LOCKED)'));
  console.log(`  → ${counts.done} jobs done, ${counts.retry} retried, ${counts.dead} dead-letter\n`);

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
  console.log(dim('  Spam, the vendor and the Spanish lead are still plain contacts here: classifying them is the next step (AI, wave 5).'));
} finally {
  await pool.end();
  await server.stop();
}
