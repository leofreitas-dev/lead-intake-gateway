-- Every webhook, stored raw before the gateway answers 202.
-- If the process dies right after answering, the lead is still here.
create table inbox (
  id              uuid primary key default uuidv7(),  -- time-ordered ids (Postgres 18)
  source          text not null,                      -- form, email, whatsapp, portal
  -- The provider's event id or Idempotency-Key header, or a SHA-256 of
  -- source + body. A resent webhook has the same key and is not stored twice.
  idempotency_key text not null,
  headers         jsonb not null,
  body            text not null,                      -- exactly as received, even if it is broken JSON
  trace_id        text not null,                      -- follows the lead through every log line
  received_at     timestamptz not null default now(),
  constraint inbox_source_key_unique unique (source, idempotency_key)
);

-- The work queue. Workers claim ready rows with FOR UPDATE SKIP LOCKED,
-- so two workers never take the same job and nobody waits on a locked row.
create table jobs (
  id           bigint generated always as identity primary key,
  kind         text not null,                         -- what to do: process, deliver_crm, ...
  inbox_id     uuid references inbox (id),
  payload      jsonb not null default '{}',
  status       text not null default 'pending'
               check (status in ('pending', 'running', 'done', 'dead')),
  attempts     int not null default 0,
  max_attempts int not null default 10,
  run_at       timestamptz not null default now(),    -- not before this time (retry backoff)
  locked_until timestamptz,                           -- lease: if the worker dies, the job frees itself
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Only pending jobs are searched, so the index stays small as done jobs pile up.
create index jobs_ready_idx on jobs (run_at) where status = 'pending';
create index jobs_inbox_idx on jobs (inbox_id);
