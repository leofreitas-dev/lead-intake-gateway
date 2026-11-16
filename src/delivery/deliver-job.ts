import type pg from 'pg';
import { type CrmClient, type CrmContact, CrmError, externalIdFor } from '../crm/types.ts';
import type { Logger } from '../logger.ts';
import { backoffMs } from '../queue/backoff.ts';
import type { ExternalJobHandler, LeasedWorkerOptions } from '../queue/worker.ts';
import { CircuitBreaker } from './circuit-breaker.ts';
import { Throttle } from './throttle.ts';

export const DELIVER_JOB = 'deliver_crm';

/** Routes that are never sent to the CRM. */
export const NOT_DELIVERED_ROUTES = new Set(['archive']);

export interface DeliveryOptions {
  pool: pg.Pool;
  log: Logger;
  crm: CrmClient;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  rateLimitPerSec: number;
  rateLimitBurst: number;
  concurrency?: number;
  leaseMs?: number;
  now?: () => number;
}

/**
 * Everything the delivery worker needs, wired together: the CRM client, its
 * circuit breaker (the worker's gate), its throttle, and the backoff.
 * Pass the result to startWorker() or drain().
 */
export function createDelivery(opts: DeliveryOptions): LeasedWorkerOptions & { breaker: CircuitBreaker; throttle: Throttle } {
  const { pool, log, crm } = opts;
  const breaker = new CircuitBreaker({
    destination: crm.name,
    failureThreshold: opts.breakerThreshold,
    cooldownMs: opts.breakerCooldownMs,
    now: opts.now,
    onChange: (ch) => {
      const fields = { destination: ch.destination, breaker: ch.to, failures: ch.failures, reason: ch.reason };
      const seconds = `${Math.round(ch.cooldownMs / 1000)} s`;
      if (ch.to === 'open' && ch.from === 'half_open') log.warn(fields, `circuit breaker OPEN again for ${ch.destination}: ${ch.reason}; deliveries paused for ${seconds}`);
      else if (ch.to === 'open') log.warn(fields, `circuit breaker OPEN for ${ch.destination}: ${ch.reason}; deliveries paused for ${seconds}, jobs wait in the queue`);
      else if (ch.to === 'half_open') log.info(fields, `circuit breaker HALF-OPEN for ${ch.destination}: trying one delivery`);
      else log.info(fields, `circuit breaker CLOSED for ${ch.destination}: deliveries resume`);
    },
  });
  const throttle = new Throttle({ perSecond: opts.rateLimitPerSec, burst: opts.rateLimitBurst, now: opts.now });

  const send = async (contact: CrmContact, traceId: string | null) => {
    const waited = await throttle.acquire();
    try {
      const result = await crm.upsertContact(contact, { traceId });
      breaker.success();
      return { result, waited };
    } catch (err) {
      if (err instanceof CrmError) {
        if (err.countsAgainstDestination) breaker.failure(err.message);
        if (err.kind === 'rate_limited' && err.retryAfterMs) throttle.pauseFor(err.retryAfterMs);
      }
      throw err;
    }
  };

  const external: ExternalJobHandler = async (job, jobLog) => {
    // In half-open, the gate lets exactly one loop through: this job is the trial.
    const isTrial = breaker.current === 'half_open';
    try {
      await deliver(job, jobLog);
    } finally {
      // If the trial ended with no verdict (429, an error before the call),
      // free the trial slot; after success() or failure() this changes nothing.
      if (isTrial) breaker.releaseTrial();
    }
  };

  const deliver: ExternalJobHandler = async (job, jobLog) => {
    let contactId = await currentContact(pool, String(job.payload.contact_id));
    let contact = await crmSnapshot(pool, contactId);
    let { result, waited } = await send(contact, job.trace_id);
    // Each lead queues its own delivery, so two deliveries of one contact can be
    // in flight together, and the older picture can land last. So, after the CRM
    // took ours, look again: if the contact changed meanwhile, send it as it is
    // now. Whichever delivery finishes last then leaves the newest picture.
    for (let resend = 0; resend < 5; resend++) {
      const nowId = await currentContact(pool, contactId);
      const now = await crmSnapshot(pool, nowId);
      if (nowId === contactId && JSON.stringify(now) === JSON.stringify(contact)) break;
      jobLog.info({ contact_id: nowId }, 'the contact changed while it was being delivered: sending it again as it is now');
      [contactId, contact] = [nowId, now];
      ({ result, waited } = await send(contact, job.trace_id));
    }
    await pool.query(
      `insert into crm_sync (destination, contact_id, external_id, crm_id, last_job_id)
       values ($1, $2, $3, $4, $5)
       on conflict (destination, contact_id) do update
         set deliveries = crm_sync.deliveries + 1, crm_id = excluded.crm_id,
             last_job_id = excluded.last_job_id, last_delivered_at = now()`,
      [crm.name, contactId, contact.externalId, result.crmId, job.id],
    );
    jobLog.info(
      { contact_id: contactId, external_id: contact.externalId, crm_id: result.crmId, owner: contact.owner, throttled_ms: waited },
      `delivered to CRM: ${result.created ? 'created' : 'updated'} ${result.crmId} (${contact.name ?? 'no name'} → ${contact.owner})`,
    );
  };

  return {
    pool,
    log,
    kind: DELIVER_JOB,
    external,
    gate: breaker,
    maxAttempts: opts.maxAttempts,
    backoff: (attempt) => backoffMs(attempt, { baseMs: opts.backoffBaseMs, maxMs: opts.backoffMaxMs }),
    concurrency: opts.concurrency ?? 4,
    leaseMs: opts.leaseMs ?? 30_000,
    breaker,
    throttle,
  };
}

/** A contact may have been merged into another since the job was queued: deliver the survivor. */
export async function currentContact(pool: pg.Pool, contactId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `with recursive chain as (
       select id, merged_into, 0 as depth from contacts where id = $1
       union all
       select c.id, c.merged_into, chain.depth + 1 from contacts c join chain on c.id = chain.merged_into where chain.depth < 50
     )
     select id from chain where merged_into is null`,
    [contactId],
  );
  if (!rows[0]) throw Object.assign(new Error(`contact ${contactId} not found`), { retryable: false });
  return rows[0].id;
}

/**
 * The contact as the CRM should see it now. The whole picture every time, so
 * a repeated or late delivery leaves the CRM right.
 */
export async function crmSnapshot(pool: pg.Pool, contactId: string): Promise<CrmContact> {
  const { rows } = await pool.query(
    `select c.display_name,
            coalesce((select array_agg(value order by value) from contact_identifiers where contact_id = c.id and kind = 'email'), '{}') as emails,
            coalesce((select array_agg(value order by value) from contact_identifiers where contact_id = c.id and kind = 'phone'), '{}') as phones,
            (select count(*)::int from leads where contact_id = c.id) as lead_count,
            (select array_agg(source order by first) from (select source, min(occurred_at) as first from leads where contact_id = c.id group by source) s) as sources,
            (select max(occurred_at) from leads where contact_id = c.id) as last_lead_at,
            (with recursive absorbed as (
               select id from contacts where merged_into = c.id
               union all
               select m.id from contacts m join absorbed a on m.merged_into = a.id)
             select coalesce(array_agg(id::text order by id), '{}') from absorbed) as absorbed,
            latest.route, latest.reason, latest.intent, latest.urgency, latest.budget_band, latest.language
       from contacts c
       left join lateral (
         select r.route, r.reason, k.intent, k.urgency, k.budget_band, k.language
           from leads l
           join lead_routes r on r.lead_id = l.id
           left join lead_classifications k on k.lead_id = l.id
          where l.contact_id = c.id and r.route <> 'archive'
          order by l.occurred_at desc, l.id desc
          limit 1) latest on true
      where c.id = $1`,
    [contactId],
  );
  const r = rows[0];
  if (!r) throw Object.assign(new Error(`contact ${contactId} not found`), { retryable: false });
  return {
    externalId: externalIdFor(contactId),
    name: r.display_name,
    emails: r.emails,
    phones: r.phones,
    owner: r.route ?? 'manual_review',
    ownerReason: r.reason ?? 'no routed lead',
    intent: r.intent,
    urgency: r.urgency,
    budgetBand: r.budget_band,
    language: r.language,
    leadCount: r.lead_count,
    sources: r.sources ?? [],
    lastLeadAt: new Date(r.last_lead_at).toISOString(),
    mergedExternalIds: (r.absorbed as string[]).map(externalIdFor),
  };
}
