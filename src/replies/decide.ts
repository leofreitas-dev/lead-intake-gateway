// A person approves, edits or rejects a reply draft. Approved replies are
// written to the outbox folder; nothing is ever sent from here.
import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { checkout } from '../db/database.ts';

export const MAX_REPLY_CHARS = 2_000;

export type Decision =
  | { ok: true; status: 'approved' | 'edited' | 'rejected'; draftId: string; outboxFile: string | null }
  | { ok: false; error: 'not_found' | 'already_decided' | 'empty_reply' | 'too_long'; status?: string };

interface DraftRow {
  id: string;
  status: string;
  channel: string;
  language: string | null;
  ai_body: string | null;
  lead_id: string;
  contact_id: string;
  trace_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * Approve a draft as it is (body left out, or the same text) or with an edited
 * text. Writes outbox/reply-<id>.json and marks the draft, in one transaction:
 * the row lock means two people clicking at once decide it only once.
 */
export async function approveDraft(pool: pg.Pool, opts: { id: string; body?: string; by: string; outboxDir: string }): Promise<Decision> {
  return decide(pool, opts.id, async (client, draft) => {
    const text = (opts.body ?? draft.ai_body ?? '').trim();
    if (!text) return { ok: false, error: 'empty_reply' };
    if (text.length > MAX_REPLY_CHARS) return { ok: false, error: 'too_long' };
    const status = draft.ai_body !== null && text === draft.ai_body.trim() ? 'approved' : 'edited';
    const decidedAt = new Date().toISOString();
    const file = path.join(opts.outboxDir, `reply-${draft.id}.json`);
    writeAtomically(file, JSON.stringify(outboxMessage(draft, text, status, opts.by, decidedAt), null, 2) + '\n');
    await client.query(
      `update reply_drafts set status = $2, final_body = $3, decided_at = $4, decided_by = $5, outbox_file = $6 where id = $1`,
      [draft.id, status, text, decidedAt, opts.by, path.basename(file)],
    );
    await timeline(client, draft, { draft_id: draft.id, status, outbox_file: path.basename(file) });
    return { ok: true, status, draftId: draft.id, outboxFile: path.basename(file) };
  });
}

/** Reject a draft: it never goes out. */
export async function rejectDraft(pool: pg.Pool, opts: { id: string; reason?: string; by: string }): Promise<Decision> {
  return decide(pool, opts.id, async (client, draft) => {
    const reason = opts.reason?.trim().slice(0, 500) || null;
    await client.query(
      `update reply_drafts set status = 'rejected', reject_reason = $2, decided_at = now(), decided_by = $3 where id = $1`,
      [draft.id, reason, opts.by],
    );
    await timeline(client, draft, { draft_id: draft.id, status: 'rejected', reason });
    return { ok: true, status: 'rejected', draftId: draft.id, outboxFile: null };
  });
}

async function decide(pool: pg.Pool, id: string, act: (client: pg.PoolClient, draft: DraftRow) => Promise<Decision>): Promise<Decision> {
  if (!/^\d{1,18}$/.test(id)) return { ok: false, error: 'not_found' };
  const { client, release } = await checkout(pool);
  try {
    await client.query('begin');
    const { rows } = await client.query<DraftRow>(
      `select d.id, d.status, d.channel, d.language, d.ai_body, d.lead_id, l.contact_id, l.trace_id, l.name, l.email, l.phone
         from reply_drafts d join leads l on l.id = d.lead_id
        where d.id = $1 for update of d`,
      [id],
    );
    const draft = rows[0];
    let result: Decision;
    if (!draft) result = { ok: false, error: 'not_found' };
    else if (draft.status !== 'pending' && draft.status !== 'blocked') result = { ok: false, error: 'already_decided', status: draft.status };
    else result = await act(client, draft);
    await client.query(result.ok ? 'commit' : 'rollback');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    release();
  }
}

/** What goes in the outbox: everything a person (or a sender) needs, and a clear "not sent". */
export function outboxMessage(draft: DraftRow, body: string, status: string, by: string, decidedAt: string) {
  const byPhone = draft.channel === 'whatsapp' || !draft.email;
  return {
    not_sent: 'Demo outbox: this reply was approved, not sent. Nothing leaves this machine.',
    draft_id: Number(draft.id),
    lead_id: draft.lead_id,
    trace_id: draft.trace_id,
    channel: draft.channel,
    to: { name: draft.name, ...(byPhone ? { phone: draft.phone } : { email: draft.email }) },
    language: draft.language,
    ...(byPhone ? {} : { subject: draft.language === 'es' ? 'Re: su mensaje a Juniper Lane Realty' : 'Re: your message to Juniper Lane Realty' }),
    body,
    decision: status,
    decided_by: by,
    decided_at: decidedAt,
  };
}

async function timeline(client: pg.PoolClient, draft: DraftRow, detail: Record<string, unknown>) {
  await client.query(`insert into contact_events (contact_id, kind, lead_id, detail, occurred_at) values ($1, 'reply', $2, $3, now())`, [
    draft.contact_id, draft.lead_id, detail,
  ]);
}

/** Write to a temporary file, then rename: the outbox never holds half a file. */
function writeAtomically(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
