import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { createPool } from '../src/db/database.ts';
import { verifySignature } from '../src/gateway/signature.ts';
import { silentLog, testGatewayConfig } from './helpers.ts';

interface N8nNode { name: string; type: string; parameters: Record<string, any>; credentials?: Record<string, { id: string; name: string }> }
interface N8nWorkflow { name: string; nodes: N8nNode[]; connections: Record<string, { main: { node: string }[][] }> }

const load = (file: string): { file: string; text: string; workflow: N8nWorkflow } => {
  const text = fs.readFileSync(`n8n/${file}`, 'utf8');
  return { file, text, workflow: JSON.parse(text) };
};
const FILES = [load('lead-form-to-gateway.json'), load('drafts-waiting-for-approval.json')];
const node = (w: N8nWorkflow, type: string) => w.nodes.find((n) => n.type === type)!;

describe('the n8n workflows in n8n/', () => {
  // The routes are checked against the real app; no database needed.
  const pool = createPool('postgres://nobody@127.0.0.1:1/none', silentLog);
  let app: App;
  beforeAll(async () => {
    app = buildApp({ pool, log: silentLog, gateway: testGatewayConfig(), admin: { token: 'test-admin-token-0123456789', usingDemoToken: false, outboxDir: 'outbox' } });
    await app.ready(); // the routes are registered by plugins
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it.each(FILES)('$file carries no secret: credentials are referenced by name only', ({ text, workflow }) => {
    expect(text).not.toMatch(/demo-only-|hmacSecret|"token"\s*:|"password"\s*:|Bearer\s+\w/);
    for (const n of workflow.nodes) {
      for (const ref of Object.values(n.credentials ?? {})) expect(Object.keys(ref).sort()).toEqual(['id', 'name']);
    }
  });

  it.each(FILES)('$file is wired: every connection goes to a node that exists', ({ workflow }) => {
    const names = new Set(workflow.nodes.map((n) => n.name));
    expect(names.size).toBe(workflow.nodes.length);
    for (const [from, out] of Object.entries(workflow.connections)) {
      expect(names.has(from), from).toBe(true);
      for (const target of out.main.flat()) expect(names.has(target.node), target.node).toBe(true);
    }
  });

  it.each(FILES)('$file calls only routes the gateway really has', ({ workflow }) => {
    const calls = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const url = new URL(call.parameters.url);
      expect(app.hasRoute({ method: (call.parameters.method ?? 'GET') as 'GET', url: url.pathname.replace('/webhooks/form', '/webhooks/:source') }), url.pathname).toBe(true);
    }
  });

  it('the form workflow signs the way the gateway checks: HMAC-SHA256 hex of "<t>.<body>"', () => {
    const { workflow } = FILES[0];
    const crypto = node(workflow, 'n8n-nodes-base.crypto');
    expect(crypto.parameters).toMatchObject({ action: 'hmac', type: 'SHA256', encoding: 'hex', value: '={{ $json.t }}.{{ $json.body }}', dataPropertyName: 'signature' });
    const http = node(workflow, 'n8n-nodes-base.httpRequest');
    expect(http.parameters).toMatchObject({ contentType: 'raw', rawContentType: 'application/json', body: '={{ $json.body }}' });
    const headers = Object.fromEntries(http.parameters.headerParameters.parameters.map((h: { name: string; value: string }) => [h.name, h.value]));
    expect(headers['X-Signature']).toBe('=t={{ $json.t }},v1={{ $json.signature }}');
    expect(headers['X-Event-Id']).toBe('={{ $json.event_id }}');

    // What n8n computes with those settings, the gateway accepts.
    const secret = 'a-form-secret-for-the-test';
    const body = JSON.stringify({ form_id: 'n8n-contact', name: 'Maya Brooks', email: 'maya.brooks@example.test', phone: '(917) 555-0163', message: 'Hi!' });
    const t = 1_794_834_000;
    const signature = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    expect(verifySignature({ header: `t=${t},v1=${signature}`, rawBody: body, secret, toleranceSec: 300, nowSec: t })).toEqual({ ok: true });
  });

  it('the drafts workflow only reads: one GET, announced once per draft id, nothing that approves', () => {
    const { workflow } = FILES[1];
    const calls = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
    expect(calls.map((c) => [c.parameters.method ?? 'GET', new URL(c.parameters.url).pathname])).toEqual([['GET', '/api/drafts']]);
    expect(node(workflow, 'n8n-nodes-base.removeDuplicates').parameters).toMatchObject({ operation: 'removeItemsSeenInPreviousExecutions', dedupeValue: '={{ $json.id }}' });
    expect(JSON.stringify(workflow)).not.toMatch(/\/(approve|reject)\b/);
  });
});
