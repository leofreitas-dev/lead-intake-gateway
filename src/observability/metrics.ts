// GET /metrics, in the Prometheus text format.
//
// Two kinds of numbers:
//   - what THIS process saw, counted as it happens: webhooks by channel and
//     outcome, and how long the gateway took to answer (a histogram);
//   - what the DATABASE says, read at each scrape: the queue by kind and status,
//     failed attempts, dead-letter, duplicates caught, AI calls, tokens and cost.
//     These are the same for every process sharing the queue, and survive a restart.
// The circuit breaker lives in memory, so it is the one of the process that serves /metrics.
import type pg from 'pg';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { CrmStatus } from '../admin/dashboard.ts';
import { isSource } from '../sources.ts';

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** What happened to a webhook, from the status code the gateway answered with. */
export type WebhookOutcome =
  | 'accepted' | 'duplicate' | 'invalid_payload' | 'bad_signature' | 'rate_limited'
  | 'unknown_source' | 'too_large' | 'unsupported_media_type' | 'storage_unavailable' | 'error';

const OUTCOME_BY_STATUS: Record<number, WebhookOutcome> = {
  202: 'accepted', 400: 'invalid_payload', 401: 'bad_signature', 404: 'unknown_source',
  413: 'too_large', 415: 'unsupported_media_type', 429: 'rate_limited', 503: 'storage_unavailable',
};

export function webhookOutcome(status: number, duplicate: boolean): WebhookOutcome {
  if (status === 202 && duplicate) return 'duplicate';
  return OUTCOME_BY_STATUS[status] ?? 'error';
}

const BREAKER_STATES = ['closed', 'open', 'half_open'] as const;

export class Metrics {
  readonly registry = new Registry();
  private readonly webhooks: Counter<'source' | 'outcome'>;
  private readonly webhookSeconds: Histogram<'source' | 'outcome'>;
  private readonly db: Record<string, Gauge<string>>;

  private readonly opts: { pool: pg.Pool; crmStatus?: () => CrmStatus; processMetrics?: boolean };

  constructor(opts: { pool: pg.Pool; crmStatus?: () => CrmStatus; processMetrics?: boolean }) {
    this.opts = opts;
    const r = [this.registry];
    if (opts.processMetrics) collectDefaultMetrics({ register: this.registry });

    this.webhooks = new Counter({
      name: 'lig_webhooks_total',
      help: 'Webhooks answered by this process, by channel and outcome (accepted, duplicate, bad_signature, ...).',
      labelNames: ['source', 'outcome'], registers: r,
    });
    this.webhookSeconds = new Histogram({
      name: 'lig_webhook_duration_seconds',
      help: 'Time from request to answer for POST /webhooks/:source, as measured by this process.',
      labelNames: ['source', 'outcome'], registers: r,
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    });

    const gauge = (name: string, help: string, labelNames: string[] = []) => new Gauge({ name, help, labelNames, registers: r });
    this.db = {
      up: gauge('lig_database_up', '1 if the last scrape could read the database, 0 if not.'),
      jobs: gauge('lig_jobs', 'Jobs in the queue by kind and status (pending, running, dead). Done jobs are not counted.', ['kind', 'status']),
      oldest: gauge('lig_job_oldest_pending_seconds', 'Age of the oldest pending job of each kind, in seconds (0 when none).', ['kind']),
      failed: gauge('lig_job_failed_attempts', 'Failed attempts recorded on the jobs in the queue table, by kind (a replay resets a job).', ['kind']),
      replays: gauge('lig_job_replays', 'Times a person sent a dead job back to the queue, by kind.', ['kind']),
      inbox: gauge('lig_inbox_webhooks', 'Webhooks stored, by channel (one row per distinct webhook).', ['source']),
      resends: gauge('lig_inbox_resends', 'Resent webhooks recognised and not stored again, by channel (all processes, all time).', ['source']),
      merges: gauge('lig_contact_merges', 'Contacts merged because the same person arrived through different channels.'),
      contacts: gauge('lig_contacts', 'Contacts that are not merged into another one.'),
      aiCalls: gauge('lig_ai_calls', 'Calls to the model (or recorded answers replayed), by purpose, mode and outcome.', ['purpose', 'mode', 'outcome']),
      aiTokens: gauge('lig_ai_tokens', 'Tokens of AI calls, by purpose, mode and direction (input, output).', ['purpose', 'mode', 'direction']),
      aiCost: gauge('lig_ai_cost_usd', 'Cost of AI calls in US dollars, by purpose and mode (recorded: what the recording cost once).', ['purpose', 'mode']),
      drafts: gauge('lig_reply_drafts', 'Reply drafts by status (pending, blocked, approved, edited, rejected, superseded).', ['status']),
      breaker: gauge('lig_circuit_breaker_state', 'Circuit breaker of this process: 1 for the current state, 0 for the others.', ['destination', 'state']),
      breakerFailures: gauge('lig_circuit_breaker_consecutive_failures', 'Failures in a row seen by the circuit breaker of this process.', ['destination']),
    };
  }

  /** Called once per webhook answer. */
  observeWebhook(source: string, status: number, duplicate: boolean, seconds: number) {
    // Only the 4 real channels become labels: a flood of made-up names must not create new series.
    const label = isSource(source) ? source : 'unknown';
    const outcome = webhookOutcome(status, duplicate);
    this.webhooks.inc({ source: label, outcome });
    this.webhookSeconds.observe({ source: label, outcome }, seconds);
  }

  /** Reads the database numbers, then renders every metric. */
  async render(): Promise<string> {
    await this.refreshFromDatabase();
    this.refreshBreaker();
    return this.registry.metrics();
  }

  private refreshBreaker() {
    this.db.breaker.reset();
    this.db.breakerFailures.reset();
    const status = this.opts.crmStatus?.();
    if (!status) return;
    const { destination, state, failuresInARow } = status.breaker;
    for (const s of BREAKER_STATES) this.db.breaker.set({ destination, state: s }, s === state ? 1 : 0);
    this.db.breakerFailures.set({ destination }, failuresInARow);
  }

  private async refreshFromDatabase() {
    const { pool } = this.opts;
    let rows;
    try {
      rows = await Promise.all([
        pool.query(`select kind, status, count(*)::int as n,
                           coalesce(extract(epoch from now() - min(run_at) filter (where run_at <= now())), 0)::float as oldest
                      from jobs where status <> 'done' group by kind, status`),
        // Failed attempts: done or running → all but the last (or current) one;
        // pending → every attempt made so far; dead → all of them.
        pool.query(`select kind,
                           sum(case when status in ('done', 'running') then greatest(attempts - 1, 0) else attempts end)::int as failed,
                           sum(replays)::int as replays
                      from jobs group by kind`),
        pool.query(`select source, count(*)::int as n, sum(resends)::int as resends from inbox group by source`),
        pool.query(`select (select count(*)::int from contact_events where kind = 'merged') as merges,
                           (select count(*)::int from contacts where merged_into is null) as contacts`),
        pool.query(`select purpose, ai_mode, outcome, count(*)::int as calls, sum(input_tokens)::float as input,
                           sum(output_tokens)::float as output, sum(cost_usd)::float as cost
                      from ai_calls group by purpose, ai_mode, outcome`),
        pool.query(`select status, count(*)::int as n from reply_drafts group by status`),
      ]);
    } catch {
      this.db.up.set(0);
      return;
    }
    const [jobs, allJobs, inbox, people, ai, drafts] = rows;
    for (const g of Object.values(this.db)) if (g !== this.db.breaker && g !== this.db.breakerFailures) g.reset();
    this.db.up.set(1);

    const kinds = new Set<string>(allJobs.rows.map((r) => r.kind));
    for (const kind of kinds) {
      for (const status of ['pending', 'running', 'dead']) this.db.jobs.set({ kind, status }, 0);
      this.db.oldest.set({ kind }, 0);
    }
    for (const r of jobs.rows) {
      this.db.jobs.set({ kind: r.kind, status: r.status }, r.n);
      if (r.status === 'pending') this.db.oldest.set({ kind: r.kind }, Math.max(0, r.oldest));
    }
    for (const r of allJobs.rows) {
      this.db.failed.set({ kind: r.kind }, r.failed);
      this.db.replays.set({ kind: r.kind }, r.replays);
    }
    for (const r of inbox.rows) {
      this.db.inbox.set({ source: r.source }, r.n);
      this.db.resends.set({ source: r.source }, r.resends);
    }
    this.db.merges.set(people.rows[0].merges);
    this.db.contacts.set(people.rows[0].contacts);
    for (const r of ai.rows) {
      this.db.aiCalls.set({ purpose: r.purpose, mode: r.ai_mode, outcome: r.outcome }, r.calls);
      this.db.aiTokens.inc({ purpose: r.purpose, mode: r.ai_mode, direction: 'input' }, r.input);
      this.db.aiTokens.inc({ purpose: r.purpose, mode: r.ai_mode, direction: 'output' }, r.output);
      this.db.aiCost.inc({ purpose: r.purpose, mode: r.ai_mode }, r.cost);
    }
    for (const r of drafts.rows) this.db.drafts.set({ status: r.status }, r.n);
  }
}
