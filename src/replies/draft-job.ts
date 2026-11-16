import type { PriceList } from '../ai/pricing.ts';
import { type Drafter, fillFirstName, firstNameOf, wantsDraft, writeDraft } from '../ai/draft.ts';
import type { JobHandler } from '../queue/worker.ts';

export const DRAFT_JOB = 'draft_reply';

/**
 * The "draft_reply" job: the AI writes a first reply, which waits for a person.
 *
 * Like classification, the AI call happens before anything is written, and
 * everything commits together with "job done". One person gets one reply: if
 * the same contact already has a draft waiting, the draft of the newer lead
 * wins and the other is marked superseded (the person sees both messages).
 */
export function makeDraftHandler({ drafter, prices }: { drafter: Drafter; prices: PriceList }): JobHandler {
  return async (client, job, log) => {
    const leadId = String(job.payload.lead_id);
    const { rows } = await client.query(
      `select l.source, l.message, l.listing_ref, l.name, l.occurred_at, l.contact_id, c.display_name,
              r.route, k.intent, k.urgency, k.language,
              exists (select 1 from reply_drafts d where d.lead_id = l.id) as done
         from leads l
         join contacts c on c.id = l.contact_id
         join lead_routes r on r.lead_id = l.id
         join lead_classifications k on k.lead_id = l.id
        where l.id = $1`,
      [leadId],
    );
    const lead = rows[0];
    if (!lead) throw new Error(`lead ${leadId} not found or not classified yet`);
    if (lead.done) {
      log.info({ lead_id: leadId }, 'reply already drafted: nothing to do');
      return;
    }
    if (!wantsDraft(lead.route, lead.intent)) {
      log.info({ lead_id: leadId, route: lead.route }, 'no reply draft for this route');
      return;
    }

    const result = await writeDraft(drafter, prices, {
      source: lead.source,
      message: lead.message,
      listingRef: lead.listing_ref,
      route: lead.route,
      classification: { intent: lead.intent, urgency: lead.urgency, language: lead.language },
    });
    for (const call of result.calls) {
      await client.query(
        `insert into ai_calls (lead_id, purpose, attempt, ai_mode, model, input_tokens, output_tokens, cost_usd, stop_reason, outcome, error)
         values ($1, 'draft', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [leadId, call.attempt, drafter.mode, call.model, call.inputTokens, call.outputTokens, call.costUsd, call.stopReason, call.outcome, call.error],
      );
    }

    // One draft at a time per contact: two drafts of the same person never race.
    await client.query(`select pg_advisory_xact_lock(hashtextextended('reply:' || $1::text, 0))`, [lead.contact_id]);
    const { rows: newer } = await client.query<{ id: string }>(
      `select d.id from reply_drafts d join leads l on l.id = d.lead_id
        where l.contact_id = $1 and d.status in ('pending', 'blocked') and (l.occurred_at, l.id) > ($2, $3::uuid)
        limit 1`,
      [lead.contact_id, lead.occurred_at, leadId],
    );
    const status = newer[0] ? 'superseded' : result.status === 'ready' ? 'pending' : 'blocked';
    const firstName = firstNameOf(lead.name) ?? firstNameOf(lead.display_name);
    const { rows: inserted } = await client.query<{ id: string }>(
      `insert into reply_drafts (lead_id, status, channel, language, ai_body, problems, ai_mode, model, input_tokens, output_tokens, cost_usd, superseded_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [leadId, status, lead.source, result.draft?.language ?? lead.language, result.draft ? fillFirstName(result.draft.body, firstName) : null,
        JSON.stringify(result.problems), drafter.mode, drafter.model, result.inputTokens, result.outputTokens, result.costUsd, newer[0]?.id ?? null],
    );
    const draftId = inserted[0].id;
    if (!newer[0]) {
      await client.query(
        `update reply_drafts d set status = 'superseded', superseded_by = $2
           from leads l
          where l.id = d.lead_id and l.contact_id = $1 and d.status in ('pending', 'blocked') and d.id <> $2`,
        [lead.contact_id, draftId],
      );
    }
    await client.query(
      `insert into contact_events (contact_id, kind, lead_id, detail, occurred_at) values ($1, 'reply', $2, $3, now())`,
      [lead.contact_id, leadId, { draft_id: draftId, status: status === 'blocked' ? 'needs_writing' : 'drafted', problems: result.problems }],
    );
    log.info(
      { lead_id: leadId, draft_id: draftId, status, language: result.draft?.language, problems: result.problems, cost_usd: result.costUsd },
      status === 'blocked' ? `no safe reply draft: a person writes it (${result.problems.join('; ')})` : `reply drafted: waiting for approval (#${draftId})`,
    );
  };
}
