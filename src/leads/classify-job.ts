import type { Classifier } from '../ai/classifier.ts';
import { classifyLead, MIN_CONFIDENCE } from '../ai/classify.ts';
import { wantsDraft } from '../ai/draft.ts';
import type { PriceList } from '../ai/pricing.ts';
import { DRAFT_JOB } from '../replies/draft-job.ts';
import { DELIVER_JOB, NOT_DELIVERED_ROUTES } from '../delivery/deliver-job.ts';
import type { JobHandler } from '../queue/worker.ts';
import { decideRoute, ROUTES } from '../routing/rules.ts';

export const CLASSIFY_JOB = 'classify';

export interface ClassifyJobOptions {
  classifier: Classifier;
  prices: PriceList;
  minConfidence?: number;
}

/**
 * The "classify" job: the AI describes the lead, the code picks the route.
 *
 * The AI call happens before anything is written. If it fails (network, 429,
 * 5xx), the job rolls back and the queue retries it later; a lead is never
 * routed without an answer. Everything this job writes (the calls, the
 * classification, the route, the timeline event) commits together with
 * "job done", so a lead is never half classified.
 */
export function makeClassifyHandler({ classifier, prices, minConfidence = MIN_CONFIDENCE }: ClassifyJobOptions): JobHandler {
  return async (client, job, log) => {
    const leadId = String(job.payload.lead_id);
    const { rows } = await client.query<{ source: string; message: string | null; listing_ref: string | null; occurred_at: Date; done: boolean }>(
      `select source, message, listing_ref, occurred_at,
              exists (select 1 from lead_classifications c where c.lead_id = l.id) as done
         from leads l where id = $1`,
      [leadId],
    );
    const lead = rows[0];
    if (!lead) throw new Error(`lead ${leadId} not found`);
    if (lead.done) {
      log.info({ lead_id: leadId }, 'lead already classified: nothing to do');
      return;
    }

    const result = await classifyLead(classifier, prices, { source: lead.source, message: lead.message, listingRef: lead.listing_ref }, { minConfidence });
    const decision = decideRoute(result);
    const c = result.classification;

    for (const call of result.calls) {
      await client.query(
        `insert into ai_calls (lead_id, attempt, ai_mode, model, input_tokens, output_tokens, cost_usd, stop_reason, outcome, error)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [leadId, call.attempt, classifier.mode, call.model, call.inputTokens, call.outputTokens, call.costUsd, call.stopReason, call.outcome, call.error],
      );
    }
    await client.query(
      `insert into lead_classifications (lead_id, status, intent, urgency, budget_band, language, confidence, evidence, review_reason,
                                         ai_mode, model, input_tokens, output_tokens, cost_usd)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [leadId, result.status, c?.intent, c?.urgency, c?.budget_band, c?.language, c?.confidence, c?.evidence, result.reviewReason,
        classifier.mode, classifier.model, result.inputTokens, result.outputTokens, result.costUsd],
    );
    await client.query('insert into lead_routes (lead_id, route, rule, reason) values ($1, $2, $3, $4)', [
      leadId, decision.route, decision.rule, decision.reason,
    ]);
    // Lock the lead row only now (not during the AI call), so a merge running
    // at the same time either finishes first or waits for us: the event always
    // lands on the contact the lead belongs to.
    await client.query(
      `insert into contact_events (contact_id, kind, lead_id, detail, occurred_at)
       select contact_id, 'routed', id, $2, occurred_at from leads where id = $1 for update`,
      [leadId, { route: decision.route, rule: decision.rule, reason: decision.reason, intent: c?.intent ?? null }],
    );
    // Next step, in the same transaction: deliver the contact to the CRM (spam never goes).
    if (!NOT_DELIVERED_ROUTES.has(decision.route)) {
      await client.query(
        `insert into jobs (kind, inbox_id, payload, trace_id)
         select $2, inbox_id, jsonb_build_object('contact_id', contact_id, 'lead_id', id), trace_id from leads where id = $1`,
        [leadId, DELIVER_JOB],
      );
    }
    // And, for buyers, sellers and renters, a reply draft for a person to approve.
    if (wantsDraft(decision.route, c?.intent)) {
      await client.query(
        `insert into jobs (kind, inbox_id, payload, trace_id)
         select $2, inbox_id, jsonb_build_object('lead_id', id), trace_id from leads where id = $1`,
        [leadId, DRAFT_JOB],
      );
    }

    log.info(
      { lead_id: leadId, status: result.status, intent: c?.intent, urgency: c?.urgency, confidence: c?.confidence, route: decision.route,
        ai_mode: classifier.mode, input_tokens: result.inputTokens, output_tokens: result.outputTokens, cost_usd: result.costUsd },
      `lead routed: ${ROUTES[decision.route]} (${decision.reason})`,
    );
  };
}
