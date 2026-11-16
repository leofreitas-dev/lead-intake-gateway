// The numbers behind the approval screen: drafts waiting, and the panel.
import type pg from 'pg';
import type { BreakerSnapshot } from '../delivery/circuit-breaker.ts';
import { listDeadJobs } from '../queue/dead-letter.ts';

/** What this process knows about the CRM right now (the breaker lives in memory). */
export interface CrmStatus {
  url: string;
  breaker: BreakerSnapshot;
}

export async function listDrafts(pool: pg.Pool, which: 'waiting' | 'decided', limit = 50) {
  const { rows } = await pool.query(
    `select d.id::text, d.status, d.language, d.ai_body, d.final_body, d.problems, d.ai_mode, d.model,
            d.input_tokens, d.output_tokens, d.cost_usd::float, d.created_at, d.decided_at, d.decided_by, d.reject_reason, d.outbox_file,
            json_build_object('id', l.id, 'source', l.source, 'name', l.name, 'email', l.email, 'phone', l.phone,
                              'message', l.message, 'listing_ref', l.listing_ref, 'occurred_at', l.occurred_at, 'trace_id', l.trace_id) as lead,
            json_build_object('status', k.status, 'intent', k.intent, 'urgency', k.urgency, 'budget_band', k.budget_band,
                              'language', k.language, 'confidence', k.confidence::float, 'evidence', k.evidence, 'review_reason', k.review_reason) as understood,
            json_build_object('route', r.route, 'rule', r.rule, 'reason', r.reason) as route,
            (select count(*)::int from leads o where o.contact_id = l.contact_id) as contact_leads,
            (select count(*)::int from reply_drafts s where s.superseded_by = d.id) as replaces
       from reply_drafts d
       join leads l on l.id = d.lead_id
       join lead_classifications k on k.lead_id = l.id
       join lead_routes r on r.lead_id = l.id
      where ${which === 'waiting' ? `d.status in ('pending', 'blocked')` : `d.status in ('approved', 'edited', 'rejected')`}
      order by ${which === 'waiting' ? `(r.route = 'on_call_agent') desc, d.created_at` : 'd.decided_at desc'}
      limit $1`,
    [limit],
  );
  return rows;
}

export async function dashboard(pool: pg.Pool, crm: CrmStatus | undefined) {
  const [channels, people, queue, ai, drafts, crmSync, dead] = await Promise.all([
    pool.query(
      `select i.source,
              count(*)::int as webhooks,
              count(l.id)::int as leads,
              coalesce(sum(i.resends), 0)::int as resends,
              count(*) filter (where i.parse_error is not null)::int as rejected
         from inbox i left join leads l on l.inbox_id = i.id
        group by i.source order by i.source`,
    ),
    pool.query(
      `select (select count(*)::int from contacts where merged_into is null) as contacts,
              (select count(*)::int from contacts where merged_into is not null) as merged_contacts,
              (select count(*)::int from leads) as leads,
              (select count(*)::int from contact_events where kind = 'merged') as merges`,
    ),
    pool.query(`select kind, status, count(*)::int as n from jobs where status <> 'done' group by kind, status order by kind, status`),
    pool.query(
      `select purpose, ai_mode, count(*)::int as calls, sum(input_tokens)::int as input_tokens, sum(output_tokens)::int as output_tokens,
              coalesce(sum(cost_usd), 0)::float as cost_usd
         from ai_calls group by purpose, ai_mode order by purpose, ai_mode`,
    ),
    pool.query(`select status, count(*)::int as n from reply_drafts group by status`),
    pool.query(
      `select count(*)::int as contacts, coalesce(sum(deliveries), 0)::int as deliveries, max(last_delivered_at) as last_delivered_at
         from crm_sync`,
    ),
    listDeadJobs(pool, { limit: 50 }),
  ]);
  const by = (rows: { status: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return {
    at: new Date().toISOString(),
    channels: channels.rows,
    people: people.rows[0],
    queue: queue.rows,
    ai: { rows: ai.rows, total_usd: ai.rows.reduce((n, r) => n + r.cost_usd, 0) },
    drafts: by(drafts.rows),
    crm: { ...crmSync.rows[0], url: crm?.url ?? null, breaker: crm?.breaker ?? null },
    dead_letter: dead,
  };
}
