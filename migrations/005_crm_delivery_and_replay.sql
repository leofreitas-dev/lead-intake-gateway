-- What each CRM holds for each contact, as far as we know: written after a
-- delivery the CRM confirmed. "deliveries" counts the calls that worked,
-- including repeats (an upsert repeated changes nothing in the CRM).
create table crm_sync (
  destination        text not null,
  contact_id         uuid not null references contacts (id),
  external_id        text not null,
  crm_id             text not null,
  deliveries         int not null default 1,
  last_job_id        bigint,
  first_delivered_at timestamptz not null default now(),
  last_delivered_at  timestamptz not null default now(),
  primary key (destination, contact_id)
);

-- Dead-letter replay: how many times a job was sent back to the queue by hand, and when.
alter table jobs add column replays int not null default 0;
alter table jobs add column last_replayed_at timestamptz;
create index jobs_dead_idx on jobs (kind, updated_at) where status = 'dead';
-- Leased jobs whose worker died are found by their expired lease.
create index jobs_running_idx on jobs (kind, locked_until) where status = 'running';

-- Contacts routed before this migration get their delivery job too (spam is never delivered).
insert into jobs (kind, inbox_id, payload, trace_id)
select distinct on (l.contact_id) 'deliver_crm', l.inbox_id, jsonb_build_object('contact_id', l.contact_id, 'lead_id', l.id), l.trace_id
  from leads l
  join lead_routes r on r.lead_id = l.id
 where r.route <> 'archive'
 order by l.contact_id, l.occurred_at desc;
