-- A contact is one person, however many channels they used.
create table contacts (
  id           uuid primary key default uuidv7(),
  display_name text,
  -- Set when this contact was found to be the same person as another one.
  -- The row stays for the audit trail; everything else moved to the survivor.
  merged_into  uuid references contacts (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- What identifies a person: a normalised email or an E.164 phone.
-- Each value belongs to exactly one contact (the primary key guarantees it).
-- Names are deliberately NOT identifiers: many people share a name.
create table contact_identifiers (
  kind       text not null check (kind in ('email', 'phone')),
  value      text not null,
  contact_id uuid not null references contacts (id),
  created_at timestamptz not null default now(),
  primary key (kind, value)
);
create index contact_identifiers_contact_idx on contact_identifiers (contact_id);

-- One row per processed webhook: what came in, cleaned up, and who it belongs to.
create table leads (
  id          uuid primary key default uuidv7(),
  inbox_id    uuid not null unique references inbox (id),  -- a webhook becomes at most one lead
  contact_id  uuid not null references contacts (id),
  source      text not null,
  name        text,
  email       text,           -- normalised: trimmed, lower case
  phone       text,           -- E.164, e.g. +12125550147
  email_raw   text,           -- exactly as the channel sent it
  phone_raw   text,
  message     text,
  listing_ref text,
  occurred_at timestamptz not null,  -- when the person wrote (from the channel), or when we received it
  trace_id    text not null,
  notes       jsonb not null default '[]',  -- what normalisation could not use, and why
  created_at  timestamptz not null default now()
);
create index leads_contact_idx on leads (contact_id, occurred_at);

-- The timeline of a contact: each lead, each new email or phone, each merge.
create table contact_events (
  id          bigint generated always as identity primary key,
  contact_id  uuid not null references contacts (id),
  kind        text not null check (kind in ('lead', 'identifier_added', 'merged')),
  lead_id     uuid references leads (id),
  detail      jsonb not null default '{}',
  occurred_at timestamptz not null,
  created_at  timestamptz not null default now()
);
create index contact_events_contact_idx on contact_events (contact_id, occurred_at, id);
