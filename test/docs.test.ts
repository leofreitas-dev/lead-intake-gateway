import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { EXAMPLE_LEAD, EXAMPLE_SECRET, EXAMPLE_SIGNATURE, EXAMPLE_TIMESTAMP } from '../src/docs/openapi.ts';
import { verifySignature } from '../src/gateway/signature.ts';
import { createPool } from '../src/db/database.ts';
import { silentLog, testGatewayConfig } from './helpers.ts';

/** Every route the server answers, as "METHOD /path" in OpenAPI style. Written by hand on purpose. */
const ROUTES = [
  'GET /health', 'GET /ready', 'GET /metrics', 'POST /webhooks/{source}',
  'GET /dead-letter', 'POST /replay', 'GET /api/drafts', 'POST /api/drafts/{id}/approve', 'POST /api/drafts/{id}/reject',
  'GET /api/dashboard', 'GET /',
];

describe('the API docs: /docs and /docs/json', () => {
  // The docs never touch the database: a pool that cannot connect is enough.
  const pool = createPool('postgres://nobody@127.0.0.1:1/none', silentLog);
  let app: App;
  let spec: { openapi: string; paths: Record<string, Record<string, { summary?: string; responses?: Record<string, unknown>; security?: unknown[] }>>; tags: { name: string; description: string }[] };
  beforeAll(async () => {
    app = buildApp({ pool, log: silentLog, gateway: testGatewayConfig(), admin: { token: 'test-admin-token-0123456789', usingDemoToken: false, outboxDir: 'outbox' } });
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    spec = res.json();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const operations = () => Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));

  it('is OpenAPI 3.1, built from the routes the server really has', async () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(operations().sort()).toEqual([...ROUTES].sort());
    // And each documented operation is a real route (not a hand-written page that can drift).
    for (const op of operations()) {
      const [method, path] = op.split(' ');
      expect(app.hasRoute({ method: method as 'GET', url: path.replace(/\{(\w+)\}/g, ':$1') }), op).toBe(true);
    }
  });

  it('describes every operation: a summary, its answers, and the token where one is needed', () => {
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(op.summary, `${method} ${path}`).toBeTruthy();
        expect(Object.keys(op.responses ?? {}).length, `${method} ${path}`).toBeGreaterThan(0);
        const needsToken = path.startsWith('/api/') || path === '/dead-letter' || path === '/replay';
        expect(Boolean(op.security?.length), `${method} ${path}`).toBe(needsToken || path.startsWith('/webhooks'));
      }
    }
    expect(Object.keys(spec.paths['/webhooks/{source}'].post.responses!).sort()).toEqual(['202', '400', '401', '404', '413', '415', '429', '503']);
  });

  it('shows a signed request whose signature is right (with the published demo secret)', () => {
    const tag = spec.tags.find((t) => t.name === 'webhooks')!;
    expect(tag.description).toContain(`X-Signature: ${EXAMPLE_SIGNATURE}`);
    expect(tag.description).toContain(EXAMPLE_LEAD);
    expect(tag.description).toContain('openssl dgst -sha256 -hmac');
    expect(verifySignature({ header: EXAMPLE_SIGNATURE, rawBody: EXAMPLE_LEAD, secret: EXAMPLE_SECRET, toleranceSec: 300, nowSec: EXAMPLE_TIMESTAMP })).toEqual({ ok: true });
    // The real secrets of this server never appear.
    expect(JSON.stringify(spec)).not.toContain(testGatewayConfig().secrets.form);
    expect(JSON.stringify(spec)).not.toContain('test-admin-token-0123456789');
  });

  it('the page works offline: every file it loads comes from this server', async () => {
    let res = await app.inject({ method: 'GET', url: '/docs' });
    if (res.statusCode === 302) res = await app.inject({ method: 'GET', url: String(res.headers.location) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const html = res.body;
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(2);
    for (const ref of refs) {
      expect(ref, ref).not.toMatch(/^(https?:)?\/\//);
      const url = new URL(ref, 'http://local/docs/').pathname;
      const asset = await app.inject({ method: 'GET', url });
      expect(asset.statusCode, url).toBe(200);
      // The page's own setup script must not point anywhere else either.
      // (Code comments aside: one links to a Stack Overflow answer.)
      if (url.endsWith('initializer.js')) expect(asset.body.replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/https?:\/\//);
    }
    expect(String(res.headers['content-security-policy'] ?? '')).toContain("default-src 'self'");
  });
});
