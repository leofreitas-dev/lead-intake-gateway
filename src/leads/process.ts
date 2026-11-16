import type { JobHandler } from '../queue/worker.ts';
import { isSource } from '../sources.ts';
import { adapters } from './adapters.ts';
import { resolveIdentity } from './identity.ts';
import { normalizeLead } from './normalize.ts';

/**
 * The "process" job: raw webhook → clean lead → the right contact.
 * Runs inside the worker's transaction (see runOneJob).
 */
export const processLead: JobHandler = async (client, job, log) => {
  const { rows } = await client.query<{ id: string; source: string; body: string; trace_id: string; received_at: Date }>(
    'select id, source, body, trace_id, received_at from inbox where id = $1',
    [job.inbox_id],
  );
  const inbox = rows[0];
  if (!inbox) throw new Error(`inbox row ${job.inbox_id} not found`);
  if (!isSource(inbox.source)) throw new Error(`unknown source "${inbox.source}"`);

  const normalized = normalizeLead(adapters[inbox.source](JSON.parse(inbox.body)));
  const result = await resolveIdentity(client, {
    ...normalized,
    inboxId: inbox.id,
    source: inbox.source,
    traceId: inbox.trace_id,
    occurredAt: normalized.occurredAt ?? inbox.received_at,
  });

  log.info(
    { lead_id: result.leadId, contact_id: result.contactId, identity: result.decision.action, notes: normalized.notes },
    `lead processed: ${result.decision.action === 'create' ? 'new contact' : result.decision.action === 'attach' ? 'existing contact' : 'two contacts merged'}`,
  );
};
