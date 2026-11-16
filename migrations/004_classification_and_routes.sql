-- Every call to the AI, paid for or not: what it cost and whether the answer was usable.
create table ai_calls (
  id            bigint generated always as identity primary key,
  lead_id       uuid not null references leads (id),
  attempt       int not null,
  ai_mode       text not null check (ai_mode in ('live', 'recorded')),
  model         text not null,
  input_tokens  int not null,
  output_tokens int not null,
  cost_usd      numeric(14, 8) not null,
  stop_reason   text not null,
  outcome       text not null check (outcome in ('valid', 'invalid', 'refused', 'no_recording')),
  error         text,
  created_at    timestamptz not null default now()
);
create index ai_calls_lead_idx on ai_calls (lead_id);

-- What the AI said about a lead (one row per lead). The AI only describes; it never routes.
create table lead_classifications (
  lead_id       uuid primary key references leads (id),
  status        text not null check (status in ('classified', 'needs_review')),
  intent        text,
  urgency       text,
  budget_band   text,
  language      text,
  confidence    numeric(4, 3),
  evidence      text,
  review_reason text,  -- why a person must check it; null when classified
  ai_mode       text not null check (ai_mode in ('live', 'recorded')),
  model         text not null,
  input_tokens  int not null,   -- all calls for this lead together
  output_tokens int not null,
  cost_usd      numeric(14, 8) not null,
  created_at    timestamptz not null default now()
);

-- Where the lead goes, decided by code from the classification, and why.
create table lead_routes (
  lead_id    uuid primary key references leads (id),
  route      text not null,
  rule       text not null,
  reason     text not null,
  created_at timestamptz not null default now()
);
create index lead_routes_route_idx on lead_routes (route);

-- The routing decision also shows on the contact's timeline.
alter table contact_events drop constraint contact_events_kind_check;
alter table contact_events add constraint contact_events_kind_check
  check (kind in ('lead', 'identifier_added', 'merged', 'routed'));

-- Leads processed before this migration get their classify job too.
insert into jobs (kind, inbox_id, payload, trace_id)
select 'classify', inbox_id, jsonb_build_object('lead_id', id), trace_id from leads;
