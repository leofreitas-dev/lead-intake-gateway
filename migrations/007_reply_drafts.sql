-- AI calls are now made for two things: classifying a lead and drafting a reply.
alter table ai_calls add column purpose text not null default 'classify' check (purpose in ('classify', 'draft'));

-- One reply draft per lead that gets one. Nothing is ever sent: an approved
-- reply is written to the outbox folder for a person (or a later system) to send.
create table reply_drafts (
  id             bigint generated always as identity primary key,
  lead_id        uuid not null unique references leads (id),
  -- pending: waiting for a person. blocked: the AI gave no safe draft, a person writes it.
  -- approved / edited: written to the outbox. rejected: never goes out.
  -- superseded: the same person wrote again; the newer lead's draft replaces this one.
  status         text not null check (status in ('pending', 'blocked', 'approved', 'edited', 'rejected', 'superseded')),
  channel        text not null,
  language       text,
  ai_body        text,                        -- what the AI wrote, name filled in; null when blocked
  problems       jsonb not null default '[]', -- why it is blocked
  final_body     text,                        -- what was approved, edited or not
  ai_mode        text not null check (ai_mode in ('live', 'recorded')),
  model          text not null,
  input_tokens   int not null,
  output_tokens  int not null,
  cost_usd       numeric(14, 8) not null,
  superseded_by  bigint references reply_drafts (id),
  decided_at     timestamptz,
  decided_by     text,
  reject_reason  text,
  outbox_file    text,
  created_at     timestamptz not null default now()
);
create index reply_drafts_waiting_idx on reply_drafts (created_at) where status in ('pending', 'blocked');

-- Resent webhooks are recognised and not stored again; now they are also counted.
alter table inbox add column resends int not null default 0;
alter table inbox add column last_resend_at timestamptz;

-- Replies show on the contact's timeline.
alter table contact_events drop constraint contact_events_kind_check;
alter table contact_events add constraint contact_events_kind_check
  check (kind in ('lead', 'identifier_added', 'merged', 'routed', 'reply'));

-- Leads routed before this migration get their draft job too.
insert into jobs (kind, inbox_id, payload, trace_id)
select 'draft_reply', l.inbox_id, jsonb_build_object('lead_id', l.id), l.trace_id
  from leads l
  join lead_routes r on r.lead_id = l.id
  join lead_classifications c on c.lead_id = l.id
 where r.route in ('on_call_agent', 'buyer_team', 'listing_team', 'rentals_desk', 'spanish_agent')
   and c.intent in ('buy', 'sell', 'rent');
