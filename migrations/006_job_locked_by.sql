-- Which process holds (or last held) a leased job: "host:pid". With several
-- worker processes, it tells whose lease ran out when one of them died.
alter table jobs add column locked_by text;
