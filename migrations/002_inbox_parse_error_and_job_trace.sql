-- A signed webhook whose body is not a JSON object is still stored (nothing is
-- thrown away), but marked here and not queued for processing.
alter table inbox add column parse_error text;
-- Which header the idempotency key came from: idempotency-key, x-event-id or body-hash.
alter table inbox add column idempotency_from text not null default 'body-hash';
alter table inbox add column remote_addr text;

-- The lead's trace id travels with every job, so each worker log line can carry it.
alter table jobs add column trace_id text;
