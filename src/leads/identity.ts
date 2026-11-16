import type pg from 'pg';
import type { NormalizedLead } from './normalize.ts';

export type IdentifierKind = 'email' | 'phone';

/** A contact found through one of the lead's identifiers. */
export interface Match {
  contactId: string;
  createdAt: Date;
}

export type Decision =
  | { action: 'create' }
  | { action: 'attach'; contactId: string; matchedBy: IdentifierKind[] }
  | { action: 'merge'; keep: string; absorb: string; matchedBy: IdentifierKind[] };

/**
 * The matching rules, with no database involved:
 * - same email, or same E.164 phone → same person;
 * - a name alone never matches (many people share a name), so it is not an input;
 * - if the email points to one contact and the phone to another, the lead proves
 *   they are the same person: merge them. The older contact survives, because it
 *   may already exist in the CRM under its id.
 */
export function decide(byEmail: Match | undefined, byPhone: Match | undefined): Decision {
  if (!byEmail && !byPhone) return { action: 'create' };
  if (byEmail && byPhone && byEmail.contactId !== byPhone.contactId) {
    const [keep, absorb] = byEmail.createdAt <= byPhone.createdAt ? [byEmail, byPhone] : [byPhone, byEmail];
    return { action: 'merge', keep: keep.contactId, absorb: absorb.contactId, matchedBy: ['email', 'phone'] };
  }
  const matchedBy: IdentifierKind[] = [];
  if (byEmail) matchedBy.push('email');
  if (byPhone) matchedBy.push('phone');
  return { action: 'attach', contactId: (byEmail ?? byPhone)!.contactId, matchedBy };
}

/**
 * Of two names for the same person, keep the more complete one:
 * more words first ("Daniel Brooks" over "Dan"), then longer ("Daniel B" over "Dan B").
 */
export function betterName(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (!current) return candidate;
  const words = (s: string) => s.split(' ').length;
  if (words(candidate) !== words(current)) return words(candidate) > words(current) ? candidate : current;
  return candidate.length > current.length ? candidate : current;
}

export interface LeadToStore extends NormalizedLead {
  inboxId: string;
  source: string;
  traceId: string;
  /** When the person wrote; falls back to when the webhook arrived. */
  occurredAt: Date;
}

export interface IdentityResult {
  leadId: string;
  contactId: string;
  decision: Decision;
}

/**
 * Finds or creates the contact for a lead, merges contacts when the lead links
 * two of them, stores the lead and writes the timeline. Runs inside the caller's
 * transaction (`client`), so all of it commits together or not at all.
 *
 * Two leads of the same person processed at the same moment must not create two
 * contacts. Each identifier gets a transaction-scoped advisory lock, always taken
 * in the same (sorted) order so two workers cannot deadlock. Contact rows are then
 * locked too, and a contact merged meanwhile is followed to its survivor.
 */
export async function resolveIdentity(client: pg.PoolClient, lead: LeadToStore): Promise<IdentityResult> {
  const identifiers: { kind: IdentifierKind; value: string }[] = [];
  if (lead.email) identifiers.push({ kind: 'email', value: lead.email });
  if (lead.phone) identifiers.push({ kind: 'phone', value: lead.phone });

  for (const key of identifiers.map((i) => `${i.kind}:${i.value}`).sort()) {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }

  const lookup = async (kind: IdentifierKind, value: string | null): Promise<Match | undefined> => {
    if (!value) return undefined;
    const { rows } = await client.query<{ contact_id: string }>(
      'select contact_id from contact_identifiers where kind = $1 and value = $2',
      [kind, value],
    );
    return rows[0] ? lockContact(client, rows[0].contact_id) : undefined;
  };
  const decision = decide(await lookup('email', lead.email), await lookup('phone', lead.phone));

  let contactId: string;
  let created = false;
  if (decision.action === 'create') {
    const { rows } = await client.query<{ id: string }>(
      'insert into contacts (display_name) values ($1) returning id',
      [lead.name],
    );
    contactId = rows[0].id;
    created = true;
  } else if (decision.action === 'attach') {
    contactId = decision.contactId;
  } else {
    contactId = decision.keep;
  }

  // The lead and its timeline entry come first, so the timeline reads
  // "lead arrived" before "and here is what it taught us".
  const { rows: leadRows } = await client.query<{ id: string }>(
    `insert into leads (inbox_id, contact_id, source, name, email, phone, email_raw, phone_raw,
                        message, listing_ref, occurred_at, trace_id, notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [
      lead.inboxId, contactId, lead.source, lead.name, lead.email, lead.phone, lead.emailRaw, lead.phoneRaw,
      lead.message, lead.listingRef, lead.occurredAt, lead.traceId, JSON.stringify(lead.notes),
    ],
  );
  const leadId = leadRows[0].id;
  await addEvent(client, contactId, 'lead', leadId, lead.occurredAt, {
    source: lead.source,
    matched_by: decision.action === 'create' ? [] : decision.matchedBy,
    new_contact: created,
  });

  if (decision.action === 'merge') {
    await mergeContacts(client, decision.keep, decision.absorb, leadId, lead);
  }

  for (const { kind, value } of identifiers) {
    const inserted = await client.query(
      `insert into contact_identifiers (kind, value, contact_id) values ($1, $2, $3)
       on conflict (kind, value) do nothing`,
      [kind, value, contactId],
    );
    if (inserted.rowCount === 1 && !created) {
      await addEvent(client, contactId, 'identifier_added', leadId, lead.occurredAt, { kind, value, source: lead.source });
    }
  }

  if (!created) {
    const { rows } = await client.query<{ display_name: string | null }>('select display_name from contacts where id = $1', [contactId]);
    const name = betterName(rows[0].display_name, lead.name);
    if (name !== rows[0].display_name) {
      await client.query('update contacts set display_name = $2, updated_at = now() where id = $1', [contactId, name]);
    }
  }

  return { leadId, contactId, decision };
}

/** Locks a contact row; if it was merged into another one, follows to the survivor. */
async function lockContact(client: pg.PoolClient, contactId: string): Promise<Match> {
  let id = contactId;
  for (let hops = 0; hops < 20; hops++) {
    const { rows } = await client.query<{ id: string; merged_into: string | null; created_at: Date }>(
      'select id, merged_into, created_at from contacts where id = $1 for update',
      [id],
    );
    if (!rows[0].merged_into) return { contactId: rows[0].id, createdAt: rows[0].created_at };
    id = rows[0].merged_into;
  }
  throw new Error(`contact ${contactId}: merge chain too long`);
}

/**
 * Moves everything of `absorb` to `keep`: identifiers, leads and timeline.
 * The absorbed row stays, marked merged_into, so the decision can be audited.
 */
async function mergeContacts(client: pg.PoolClient, keep: string, absorb: string, leadId: string, lead: LeadToStore): Promise<void> {
  const { rows } = await client.query<{ id: string; display_name: string | null }>(
    'select id, display_name from contacts where id = any($1)',
    [[keep, absorb]],
  );
  const nameOf = (id: string) => rows.find((r) => r.id === id)?.display_name ?? null;

  for (const table of ['contact_identifiers', 'leads', 'contact_events']) {
    await client.query(`update ${table} set contact_id = $1 where contact_id = $2`, [keep, absorb]);
  }
  await client.query('update contacts set merged_into = $1, updated_at = now() where id = $2', [keep, absorb]);
  await client.query('update contacts set display_name = $2, updated_at = now() where id = $1', [
    keep,
    betterName(nameOf(keep), nameOf(absorb)),
  ]);
  await addEvent(client, keep, 'merged', leadId, lead.occurredAt, {
    absorbed_contact: absorb,
    absorbed_name: nameOf(absorb),
    reason: `a ${lead.source} lead has email ${lead.email}, known for one contact, and phone ${lead.phone}, known for the other`,
  });
}

async function addEvent(
  client: pg.PoolClient,
  contactId: string,
  kind: 'lead' | 'identifier_added' | 'merged',
  leadId: string,
  occurredAt: Date,
  detail: Record<string, unknown>,
): Promise<void> {
  await client.query(
    'insert into contact_events (contact_id, kind, lead_id, occurred_at, detail) values ($1, $2, $3, $4, $5)',
    [contactId, kind, leadId, occurredAt, JSON.stringify(detail)],
  );
}
