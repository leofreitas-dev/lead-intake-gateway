// The OpenAPI description of each route, attached where the route is declared.
// Documentation only: the handlers check their inputs themselves (see openapi.ts).
import { SOURCES } from '../sources.ts';
import { EXAMPLE_LEAD, EXAMPLE_SIGNATURE } from './openapi.ts';

const error = (example: string, extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties: { error: { type: 'string', examples: [example] }, message: { type: 'string' }, ...extra },
  required: ['error'],
});
const admin = { security: [{ adminToken: [] }] };
const unauthorized = { 401: { description: 'Missing or wrong admin token.', ...error('admin_token_required') } };

const deadJob = {
  type: 'object',
  properties: {
    id: { type: 'string', examples: ['42'] },
    kind: { type: 'string', examples: ['deliver_crm'] },
    attempts: { type: 'integer' },
    last_error: { type: ['string', 'null'], examples: ['CRM error 500: {"error":"internal_error"}'] },
    failed_at: { type: 'string', format: 'date-time' },
    replays: { type: 'integer' },
    trace_id: { type: ['string', 'null'] },
    payload: { type: 'object', additionalProperties: true },
  },
};

const decision = {
  200: {
    description: 'Decided. Approved and edited replies are written to the outbox folder; nothing is sent.',
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['approved', 'edited', 'rejected'] },
      draft_id: { type: 'string' },
      outbox_file: { type: ['string', 'null'], examples: ['reply-12.json'] },
    },
  },
  400: { description: 'Empty, too long, or not text.', ...error('empty_reply') },
  ...unauthorized,
  404: { description: 'No draft with this id.', ...error('not_found') },
  409: { description: 'Someone already decided this draft.', ...error('already_decided', { status: { type: 'string', examples: ['approved'] } }) },
};
const draftId = { type: 'object', properties: { id: { type: 'string', pattern: '^\\d+$', description: 'Draft id' } }, required: ['id'] };

export const schemas = {
  health: {
    tags: ['health'],
    summary: 'Liveness: the process is up',
    description: 'Never touches the database, so a slow database does not get a healthy process restarted.',
    response: { 200: { type: 'object', properties: { status: { const: 'ok' }, uptime_s: { type: 'integer' } } } },
  },
  ready: {
    tags: ['health'],
    summary: 'Readiness: the process can work (the database answers)',
    response: {
      200: { type: 'object', properties: { status: { const: 'ready' }, db: { const: 'ok' } } },
      503: { description: 'The database does not answer within 2 s.', type: 'object', properties: { status: { const: 'not_ready' }, db: { const: 'down' } } },
    },
  },
  metrics: {
    tags: ['health'],
    summary: 'Prometheus metrics',
    description:
      'Text format 0.0.4. Webhooks by channel and outcome and a latency histogram (counted by this process); ' +
      'queue, attempts, dead-letter, duplicates, AI calls, tokens and cost (read from the database at each scrape); ' +
      'the circuit breaker of this process.',
    produces: ['text/plain'],
    response: { 200: { description: 'Prometheus text', content: { 'text/plain': { schema: { type: 'string', examples: ['lig_webhooks_total{source="form",outcome="accepted"} 12'] } } } } },
  },
  webhook: {
    tags: ['webhooks'],
    summary: 'Receive a lead from a channel',
    description:
      'Stored raw in the database **before** the answer, then processed by the queue. See the "webhooks" tag for how to sign. ' +
      'Checks, cheapest first: unknown channel 404 · rate limit 429 · not JSON 415 · too large 413 · signature 401 · ' +
      'broken JSON 400 (stored for a person, not processed) · database down 503 (send again) · otherwise 202.',
    security: [{ webhookSignature: [] }],
    params: { type: 'object', properties: { source: { type: 'string', enum: [...SOURCES] } }, required: ['source'] },
    headers: {
      type: 'object',
      properties: {
        'x-signature': { type: 'string', description: 't=<unix seconds>,v1=<HMAC-SHA256 hex>', examples: [EXAMPLE_SIGNATURE] },
        'idempotency-key': { type: 'string', description: 'Optional. Same key = same webhook.' },
        'x-event-id': { type: 'string', description: "Optional. The provider's event id, if there is no Idempotency-Key." },
        'x-request-id': { type: 'string', description: 'Optional trace id, kept if it is sane; returned on every answer.' },
      },
      required: ['x-signature'],
    },
    body: {
      description: "The channel's own JSON, exactly as signed (each channel has its own shape).",
      content: { 'application/json': { schema: { type: 'object', additionalProperties: true, examples: [JSON.parse(EXAMPLE_LEAD)] } } },
    },
    response: {
      202: {
        description: 'Stored and queued, or recognised as a resend (same id, duplicate: true).',
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, trace_id: { type: 'string' }, duplicate: { type: 'boolean' } },
      },
      400: { description: 'Signed, but the body is not a JSON object: stored for a person, not processed.', ...error('invalid_payload', { id: { type: 'string' }, trace_id: { type: 'string' } }) },
      401: { description: 'Missing, malformed, old or wrong signature. Nothing stored.', ...error('signature_invalid') },
      404: { description: 'No such channel.', ...error('unknown_source') },
      413: { description: 'Body larger than the limit (64 KB by default).', ...error('FST_ERR_CTP_BODY_TOO_LARGE') },
      415: { description: 'Not application/json.', ...error('FST_ERR_CTP_INVALID_MEDIA_TYPE') },
      429: { description: 'Too many requests from this caller on this channel. See Retry-After.', ...error('rate_limited', { retry_after_s: { type: 'integer' } }) },
      503: { description: 'The database is down: NOT stored. Send again later.', ...error('storage_unavailable') },
    },
  },
  console: {
    tags: ['console'],
    summary: 'The approval console (HTML page)',
    description: 'One offline page with Approvals and Dashboard tabs. It holds no data: it asks for the admin token and calls /api.',
    produces: ['text/html'],
    response: { 200: { description: 'HTML page', content: { 'text/html': { schema: { type: 'string' } } } } },
  },
  listDrafts: {
    tags: ['console'], ...admin,
    summary: 'Reply drafts waiting for a person (or the last decisions)',
    querystring: { type: 'object', properties: { status: { type: 'string', enum: ['waiting', 'decided'], default: 'waiting' } } },
    response: {
      200: {
        description: 'Each draft with the original lead, what the AI understood, the route and why.',
        type: 'object',
        properties: { count: { type: 'integer' }, drafts: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      },
      400: { description: 'Unknown status.', ...error('status must be "waiting" or "decided"') },
      ...unauthorized,
    },
  },
  approve: {
    tags: ['console'], ...admin,
    summary: 'Approve a reply draft, as it is or edited',
    description: 'Leave `body` out (or send the same text) to approve; send another text to approve it edited. Writes outbox/reply-<id>.json. Nothing is sent.',
    params: draftId,
    body: { type: 'object', properties: { body: { type: 'string', maxLength: 2000, examples: ['Hi Emily, thank you! An agent will contact you shortly.'] } } },
    response: decision,
  },
  reject: {
    tags: ['console'], ...admin,
    summary: 'Reject a reply draft',
    params: draftId,
    body: { type: 'object', properties: { reason: { type: 'string', maxLength: 500, examples: ['Agent already called this lead'] } } },
    response: decision,
  },
  dashboard: {
    tags: ['console'], ...admin,
    summary: 'The panel: channels, duplicates, queue, CRM and breaker, dead-letter, AI cost',
    response: { 200: { type: 'object', additionalProperties: true }, ...unauthorized },
  },
  deadLetter: {
    tags: ['operations'], ...admin,
    summary: 'Jobs that gave up, with their last error',
    querystring: { type: 'object', properties: { kind: { type: 'string', examples: ['deliver_crm'] } } },
    response: { 200: { type: 'object', properties: { count: { type: 'integer' }, jobs: { type: 'array', items: deadJob } } }, ...unauthorized },
  },
  replay: {
    tags: ['operations'], ...admin,
    summary: 'Send dead jobs back to the queue',
    description: 'Only dead jobs move, so replaying twice does nothing the second time. An empty body does nothing: ask for `ids` or `all`.',
    body: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: ['string', 'integer'] }, examples: [['42', '43']] },
        all: { type: 'boolean' },
        kind: { type: 'string', description: 'With all: only this kind.', examples: ['deliver_crm'] },
      },
    },
    response: {
      200: { type: 'object', properties: { replayed: { type: 'integer' }, jobs: { type: 'array', items: deadJob } } },
      400: { description: 'Neither ids nor all.', ...error('send {"ids": [...]} or {"all": true}') },
      ...unauthorized,
    },
  },
};
