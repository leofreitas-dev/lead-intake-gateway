// The API documentation: an OpenAPI document built from the routes the server
// really has (each route carries its own schema), shown at /docs by Swagger UI.
// Swagger UI's files come from node_modules: no CDN, works offline.
//
// The schemas DOCUMENT the routes; the route handlers still check every input
// themselves, exactly as before. A webhook body, for one, must stay the exact
// text that was signed, so it is never parsed and re-checked by a schema.
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { DEMO_SECRET_PREFIX } from '../config.ts';
import { signatureHeader } from '../gateway/signature.ts';

/** A fixed example, signed with the PUBLISHED demo secret of the form channel (never a real one). */
export const EXAMPLE_LEAD = JSON.stringify({
  name: 'Emily Carter',
  email: 'emily.carter@example.test',
  phone: '(212) 555-0147',
  message: 'Hi! Could we see the 3-bedroom on Maple Ave this Saturday?',
  listing_ref: 'JLR-1042',
});
export const EXAMPLE_TIMESTAMP = 1_794_834_000; // 2026-11-16T13:00:00Z: fixed, so the example is stable
export const EXAMPLE_SECRET = `${DEMO_SECRET_PREFIX}form`;
export const EXAMPLE_SIGNATURE = signatureHeader(EXAMPLE_SECRET, EXAMPLE_LEAD, EXAMPLE_TIMESTAMP);

const SIGNING = `
Every webhook is signed with the channel's secret (\`WEBHOOK_SECRET_<CHANNEL>\`), the way Stripe does it:

    X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>

The gateway refuses a missing or wrong signature, and one signed more than 5 minutes from now,
so a captured request cannot be replayed later. Sign the **exact bytes** you send.

**Example** (the demo secret of the \`form\` channel, \`${EXAMPLE_SECRET}\`, published on purpose; t is fixed here,
so this exact request is refused today as too old: sign with the current time):

    POST /webhooks/form
    Content-Type: application/json
    X-Event-Id: evt_0001
    X-Signature: ${EXAMPLE_SIGNATURE}

    ${EXAMPLE_LEAD}

**Signing with the shell** (bash + openssl):

    SECRET='${EXAMPLE_SECRET}'
    BODY='${EXAMPLE_LEAD}'
    T=$(date +%s)
    SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
    curl -i http://127.0.0.1:3000/webhooks/form \\
      -H 'content-type: application/json' -H 'x-event-id: evt_0001' \\
      -H "x-signature: t=$T,v1=$SIG" --data "$BODY"

**Signing with Node:**

    import { createHmac } from 'node:crypto';
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', secret).update(\`\${t}.\${body}\`).digest('hex');
    headers['x-signature'] = \`t=\${t},v1=\${v1}\`;

Or simply: \`npm run send -- form lead-01\`, which signs the demo fixtures for you.

**Idempotency:** a resend is recognised by \`Idempotency-Key\`, then \`X-Event-Id\`, then a hash of the body.
It gets \`202\` with the same \`id\` and \`"duplicate": true\`, and is not stored or processed again.`;

/**
 * Registers the docs on the root instance. Must come BEFORE the routes are
 * registered (as plugins), because @fastify/swagger collects them as they are added.
 */
// Any logger type: the app uses our pino logger, Fastify's default type is narrower.
export function registerDocs(app: FastifyInstance<any, any, any, any>) {
  app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Lead Intake Gateway',
        version: '0.1.0',
        description:
          'Receives leads from 4 channels, stores each webhook before answering, removes duplicates, ' +
          'classifies with AI (code decides the route), and delivers each contact to the CRM exactly once in effect. ' +
          'A person approves every reply. All data here is fictional.',
      },
      servers: [{ url: '/', description: 'This server' }],
      tags: [
        { name: 'webhooks', description: SIGNING },
        { name: 'console', description: 'The approval console and its data. Bearer token: `ADMIN_TOKEN` (demo: `demo-only-admin-token`).' },
        { name: 'operations', description: 'Dead-letter and replay. Same admin token.' },
        { name: 'health', description: 'Liveness, readiness and Prometheus metrics. No token.' },
      ],
      components: {
        securitySchemes: {
          adminToken: { type: 'http', scheme: 'bearer', description: 'ADMIN_TOKEN (the demo uses demo-only-admin-token).' },
          webhookSignature: { type: 'apiKey', in: 'header', name: 'X-Signature', description: 't=<unix seconds>,v1=<HMAC-SHA256 hex>: see the "webhooks" tag.' },
        },
      },
    },
  });
  app.register(swaggerUi, {
    routePrefix: '/docs',
    staticCSP: true,
    uiConfig: { docExpansion: 'list', deepLinking: true, validatorUrl: null, tryItOutEnabled: false, defaultModelsExpandDepth: 0 },
  });
}
