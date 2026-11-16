<!--
  Notes for the first release (v1.0.0). Created with:
  gh release create v1.0.0 --title "Lead Intake Gateway v1.0.0" --notes-file docs/release-v1.0.0.md
-->

First public version of Lead Intake Gateway.

## What it does

- **AI classifies** each lead (intent, urgency, budget, language) into a validated JSON form with a confidence, and drafts a reply.
- **Code decides** the route, merges the same person across channels, and delivers each contact to the CRM once: store before `202`, idempotent webhooks, a Postgres job queue, upsert by a stable external id, retry with backoff and jitter, a circuit breaker, a rate limit and a dead-letter with replay. 284 tests.
- **A person approves** every reply in the console. Nothing is sent: an approved reply is written to `outbox/`.

## Measured

- Chaos run (`npm run chaos`, 3 runs): 297 leads and 41 resends, the CRM down for 60 s, then 429, then 500, and a worker killed with `kill -9`. 0 lost, 0 duplicated in the CRM, 0 in the dead-letter. Reports in `reports/`.
- Bench (`npm run bench`, median of 3 runs on one laptop): p95 28.9 ms at 200 requests/s, at most 396 requests/s, 0 lost.
- AI cost in the demo: about US$ 0.26 per 1,000 leads (Claude Haiku 5.5).

## Try it

```
npm install
npm run demo
```

Requires Node 24. No API key, no database server: demo mode replays recorded AI answers and Postgres starts embedded. `npm run crm` and `npm start` open the approval console at http://127.0.0.1:3000.

## Also in this version

- `/metrics` (Prometheus), `/docs` (OpenAPI 3.1, offline) and JSON logs with a trace id from the webhook to the CRM call.
- Two n8n workflows in `n8n/`: a signed contact form, and an alert for replies waiting for approval.

## Notes

Portfolio demo: all data is fictional, and it runs locally only. The only CRM adapter included is a fake CRM that can fail on demand; a HubSpot adapter is next.
