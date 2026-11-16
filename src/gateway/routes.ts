import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { GatewayConfig } from '../config.ts';
import type { Metrics } from '../observability/metrics.ts';
import { isSource, type Source } from '../sources.ts';
import { idempotencyKey } from './idempotency.ts';
import { checkBody, storeWebhook } from './inbox.ts';
import { RateLimiter } from './rate-limiter.ts';
import { SIGNATURE_HEADER, verifySignature } from './signature.ts';

export interface GatewayDeps {
  pool: pg.Pool;
  config: GatewayConfig;
  /** Injected in tests to control time. */
  now?: () => number;
  /** Counts each answer (by channel and outcome) and how long it took. */
  metrics?: Metrics;
}

// Which answers were a recognised resend, for the metrics.
const duplicates = new WeakSet<FastifyRequest>();

type WebhookRequest = FastifyRequest<{ Params: { source: string }; Body: string }>;

// Headers that may carry credentials of a proxy or browser: never stored.
const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

/**
 * POST /webhooks/:source
 *
 * Order of checks, cheapest first:
 *   unknown channel        → 404 (nothing stored)
 *   too many requests      → 429 + Retry-After (nothing stored)
 *   not JSON content type  → 415 · body too large → 413
 *   bad or old signature   → 401 (nothing stored: we cannot trust who sent it)
 *   signed but broken body → stored for a human, 400, not queued
 *   database unavailable   → 503, so the sender retries later; never a 202
 *   otherwise              → stored raw + "process" job queued, then 202
 */
export async function webhookRoutes(app: FastifyInstance, deps: GatewayDeps): Promise<void> {
  const { pool, config } = deps;
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter({ perSecond: config.rateLimitPerSec, burst: config.rateLimitBurst, now });

  // Only JSON is accepted here (anything else gets 415). Fastify's other default
  // parsers are removed for these routes only.
  app.removeAllContentTypeParsers();
  // Keep the body as the exact string that was signed. Re-serialising parsed
  // JSON could change spacing or key order and break the signature check.
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: config.bodyLimitBytes }, (_req, body, done) =>
    done(null, body),
  );

  // Every answer is counted, the refusals too (401, 413, 429...): elapsedTime
  // runs from the first byte of the request to the last byte of the answer.
  if (deps.metrics) {
    const metrics = deps.metrics;
    app.addHook('onResponse', async (request, reply) => {
      const { source } = request.params as { source?: string };
      metrics.observeWebhook(source ?? 'unknown', reply.statusCode, duplicates.has(request), reply.elapsedTime / 1000);
    });
  }

  app.post<{ Params: { source: string }; Body: string }>(
    '/webhooks/:source',
    {
      onRequest: async (request, reply) => {
        const { source } = request.params;
        if (!isSource(source)) {
          return reply.code(404).send({ error: 'unknown_source', message: `No channel named "${source}".` });
        }
        // One bucket per channel and caller, so a flood from one address cannot
        // block the real provider of that channel.
        const verdict = limiter.take(`${source}|${request.ip}`);
        if (!verdict.allowed) {
          request.log.warn({ source, ip: request.ip }, 'rate limit reached');
          return reply
            .code(429)
            .header('retry-after', String(verdict.retryAfterSec))
            .send({ error: 'rate_limited', retry_after_s: verdict.retryAfterSec });
        }
      },
    },
    async (request: WebhookRequest, reply) => {
      const source = request.params.source as Source;
      const rawBody = typeof request.body === 'string' ? request.body : '';

      const signature = verifySignature({
        header: headerValue(request.headers[SIGNATURE_HEADER]),
        rawBody,
        secret: config.secrets[source],
        toleranceSec: config.signatureToleranceSec,
        nowSec: Math.floor(now() / 1000),
      });
      if (!signature.ok) {
        request.log.warn({ source, reason: signature.reason }, 'webhook refused: signature');
        return reply.code(401).send({ error: signature.reason });
      }

      const parseError = checkBody(rawBody);
      let stored;
      try {
        stored = await storeWebhook(pool, {
          source,
          idempotency: idempotencyKey(request.headers, rawBody),
          headers: keptHeaders(request.headers),
          rawBody,
          traceId: request.id,
          remoteAddr: request.ip,
          parseError,
        });
      } catch (err) {
        // Not stored means not accepted: answer 5xx so the provider sends it again.
        request.log.error({ source, err: (err as Error).message }, 'webhook NOT stored: database unavailable');
        return reply.code(503).header('retry-after', '5').send({ error: 'storage_unavailable' });
      }

      const fields = { source, inbox_id: stored.inboxId, trace_id: stored.traceId, duplicate: stored.duplicate };
      if (stored.parseError) {
        request.log.warn({ ...fields, parse_error: stored.parseError }, 'webhook stored but not processable');
        return reply.code(400).send({ error: 'invalid_payload', message: stored.parseError, id: stored.inboxId, trace_id: stored.traceId });
      }
      if (stored.duplicate) duplicates.add(request);
      request.log.info(fields, stored.duplicate ? 'duplicate webhook: already stored' : 'webhook stored and queued');
      return reply.code(202).send({ id: stored.inboxId, trace_id: stored.traceId, duplicate: stored.duplicate });
    },
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function keptHeaders(headers: FastifyRequest['headers']): Record<string, unknown> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !DROPPED_HEADERS.has(name)));
}
