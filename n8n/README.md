# Put the gateway in front of your n8n

Two n8n workflows that use the Lead Intake Gateway instead of repeating it.
**n8n orchestrates, the gateway guarantees**: n8n collects the lead and tells
people when something waits for them; storing, deduplicating, classifying,
routing and delivering to the CRM stay in the gateway, with its tests.

| File | What it does | What it does not do |
|---|---|---|
| [`lead-form-to-gateway.json`](lead-form-to-gateway.json) | An n8n form (Form Trigger) → the gateway's `form` payload → HMAC-SHA256 signature → `POST /webhooks/form`. The person sees "Thanks" with the gateway's reference, or "Sorry, try again" if the gateway did not answer `202` after 3 tries. | No dedupe, classification, routing or CRM call. |
| [`drafts-waiting-for-approval.json`](drafts-waiting-for-approval.json) | Every minute, asks the gateway for AI reply drafts waiting for a person (`GET /api/drafts`) and announces each new one **once**, with a link to the approval console. The last node is where you connect Slack or e-mail. | Never approves, edits or sends a reply: a person does that in the console. |

No secret is in these files. They name two n8n credentials, which you create
once (n8n stores them encrypted):

| Credential (exact name) | n8n type | Value |
|---|---|---|
| `Lead gateway: form secret` | Crypto, field *Hmac Secret* | the gateway's `WEBHOOK_SECRET_FORM` (the demo uses `demo-only-secret-form`) |
| `Lead gateway: admin token` | Bearer Auth | the gateway's `ADMIN_TOKEN` (the demo uses `demo-only-admin-token`) |

## Try it locally

You need about 2.5 GB of disk for n8n, installed inside this project and ignored by git:

```bash
npm install --prefix tools/n8n n8n@2.47.7 --no-audit --no-fund
```

Then, in three terminals:

```bash
npm run crm      # the fake CRM
npm start        # the gateway, on http://127.0.0.1:3000
npm run n8n      # n8n on http://127.0.0.1:5678, with its own Postgres (.n8n-local/, port 25440)
```

1. Open http://127.0.0.1:5678, create the local owner account, and create the two credentials above.
2. Import both files (*Workflows → Import from file*). If a node shows a credential warning, pick the credential in it.
3. Publish both workflows.
4. Open http://127.0.0.1:5678/form/juniper-contact and send a lead with fictional data (e.g. a `555-01xx` phone, an `@example.test` e-mail).
   The page answers with the gateway's reference; the lead is in the console at http://127.0.0.1:3000.
5. For the second workflow, send the demo leads (`npm run send -- portal lead-03`, `npm run send -- form lead-08`):
   within a minute its executions list one announcement per new draft, and none for drafts already announced.

A new message typed in the form goes to **manual review** with no draft: the demo
replays recorded AI answers (no key, no cost) and has none for it. With
`AI_MODE=live` the gateway asks the model.

`n8n/run-local.sh` is the same as `npm run n8n`, and passes any n8n command
through (for example `npm run n8n -- import:workflow --input=n8n/lead-form-to-gateway.json`,
with n8n stopped). Ctrl+C stops n8n and then its Postgres.
