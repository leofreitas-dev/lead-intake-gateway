import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpCrmClient } from '../src/crm/http-crm.ts';
import { type CrmContact, CrmError, externalIdFor } from '../src/crm/types.ts';
import { buildFakeCrm } from '../src/fake-crm/server.ts';
import { silentLog, until } from './helpers.ts';

const contact = (over: Partial<CrmContact> = {}): CrmContact => ({
  externalId: 'lig_contact_0001',
  name: 'Emily Carter',
  emails: ['emily.carter@example.test'],
  phones: ['+12125550147'],
  owner: 'on_call_agent',
  ownerReason: 'wants to buy and urgency is high',
  intent: 'buy',
  urgency: 'high',
  budgetBand: 'buy_500k_to_1m',
  language: 'en',
  leadCount: 1,
  sources: ['form'],
  lastLeadAt: '2026-11-16T15:02:00.000Z',
  mergedExternalIds: [],
  ...over,
});

describe('externalIdFor', () => {
  it('is stable and derived from the contact id', () => {
    expect(externalIdFor('019a2b3c-0000-7000-8000-000000000001')).toBe('lig_contact_019a2b3c000070008000000000000001');
  });
});

describe('the fake CRM and the HTTP CRM client', () => {
  let crm: ReturnType<typeof buildFakeCrm>;
  let client: HttpCrmClient;
  const setMode = (mode: string, slowMs?: number) => crm.inject({ method: 'POST', url: '/_admin/mode', payload: { mode, slowMs } });

  beforeAll(async () => {
    crm = buildFakeCrm({ log: silentLog, rateLimitPerSec: 1000 });
    await crm.listen({ port: 0, host: '127.0.0.1' });
    const { port } = crm.server.address() as { port: number };
    client = new HttpCrmClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 3_000 });
  });
  afterAll(() => crm.close());
  beforeEach(async () => {
    await crm.inject({ method: 'POST', url: '/_admin/reset' });
    await setMode('ok');
  });

  it('ok: the first delivery creates, the next ones update the SAME record (upsert by external id)', async () => {
    const first = await client.upsertContact(contact(), { traceId: 'trace-1' });
    const again = await client.upsertContact(contact({ leadCount: 2 }), { traceId: 'trace-1' });
    await client.upsertContact(contact({ leadCount: 3 }), { traceId: 'trace-1' });
    expect(first.created).toBe(true);
    expect(again).toEqual({ crmId: first.crmId, created: false });
    expect(Object.keys(crm.state.contacts)).toEqual(['lig_contact_0001']);
    expect(crm.state.contacts.lig_contact_0001).toMatchObject({ version: 3, data: { leadCount: 3 } });
    // It keeps every call, with the trace id that followed the lead.
    expect(crm.state.calls.map((c) => [c.status, c.trace_id])).toEqual([[201, 'trace-1'], [200, 'trace-1'], [200, 'trace-1']]);
  });

  it('down: the connection is dropped → "unreachable", retryable, counts against the CRM', async () => {
    await setMode('down');
    const err = await client.upsertContact(contact(), { traceId: null }).catch((e) => e);
    expect(err).toBeInstanceOf(CrmError);
    expect(err).toMatchObject({ kind: 'unreachable', retryable: true, countsAgainstDestination: true });
    expect(crm.state.calls.at(-1)).toMatchObject({ status: 'dropped', mode: 'down' });
    expect(crm.state.contacts).toEqual({});
  });

  it('500: retryable and counts against the CRM', async () => {
    await setMode('500');
    expect(await client.upsertContact(contact(), { traceId: null }).catch((e) => e)).toMatchObject({
      kind: 'server_error', status: 500, retryable: true, countsAgainstDestination: true,
    });
  });

  it('429: retryable, carries Retry-After, but does NOT count against the CRM (it is up, just busy)', async () => {
    await setMode('429');
    expect(await client.upsertContact(contact(), { traceId: null }).catch((e) => e)).toMatchObject({
      kind: 'rate_limited', retryAfterMs: 2_000, retryable: true, countsAgainstDestination: false,
    });
  });

  it('slow: the CRM saves it but answers too late → timeout; the retry updates the same record', async () => {
    // The CRM answers after 3 s; this client gives up after 0.3 s. The wide gap
    // keeps it a timeout however busy the machine is.
    await setMode('slow', 3_000);
    const impatient = new HttpCrmClient({ baseUrl: `http://127.0.0.1:${(crm.server.address() as { port: number }).port}`, timeoutMs: 300 });
    expect(await impatient.upsertContact(contact(), { traceId: null }).catch((e) => e)).toMatchObject({ kind: 'timeout', retryable: true });
    await until(() => crm.state.contacts.lig_contact_0001 !== undefined);
    expect(crm.state.contacts.lig_contact_0001.version).toBe(1); // it was saved anyway
    await setMode('ok');
    expect(await client.upsertContact(contact(), { traceId: null })).toMatchObject({ created: false });
    expect(Object.keys(crm.state.contacts)).toHaveLength(1);
  });

  it('the fake CRM refuses a body whose id does not match the URL (422)', async () => {
    const res = await crm.inject({ method: 'PUT', url: '/contacts/a', payload: contact({ externalId: 'b' }) });
    expect(res.statusCode).toBe(422);
  });

  it('a refused payload (4xx) is not retryable: trying again cannot fix our data', async () => {
    // A stand-in CRM that refuses everything with 422.
    const refusing = Fastify();
    refusing.put('/contacts/:id', async (_req, reply) => reply.code(422).send({ error: 'email is invalid' }));
    await refusing.listen({ port: 0, host: '127.0.0.1' });
    const { port } = refusing.server.address() as { port: number };
    const err = await new HttpCrmClient({ baseUrl: `http://127.0.0.1:${port}` }).upsertContact(contact(), { traceId: null }).catch((e) => e);
    await refusing.close();
    expect(err).toMatchObject({ kind: 'rejected', status: 422, retryable: false, countsAgainstDestination: false });
    expect(err.message).toMatch(/email is invalid/);
  });

  it('a merge folds the absorbed contact into the survivor, so the CRM has one active record per person', async () => {
    await client.upsertContact(contact({ externalId: 'lig_contact_dan_b', name: 'Dan B' }), { traceId: null });
    await client.upsertContact(contact({ externalId: 'lig_contact_daniel', name: 'Daniel Brooks', mergedExternalIds: ['lig_contact_dan_b'] }), { traceId: null });
    const res = await crm.inject({ method: 'GET', url: '/_admin/state' });
    expect(res.json()).toMatchObject({ contactRecords: 2, activeContacts: 1 });
  });

  it('above its own rate limit it answers 429 even in "ok" mode', async () => {
    const strict = buildFakeCrm({ log: silentLog, rateLimitPerSec: 2 });
    const put = () => strict.inject({ method: 'PUT', url: '/contacts/lig_contact_0001', payload: contact() });
    const codes = [(await put()).statusCode, (await put()).statusCode, (await put()).statusCode];
    expect(codes).toEqual([201, 200, 429]);
  });

  it('keeps its state in a file across restarts', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-crm-')), 'store.json');
    const a = buildFakeCrm({ log: silentLog, storeFile: file });
    await a.inject({ method: 'PUT', url: '/contacts/lig_contact_0001', payload: contact() });
    const b = buildFakeCrm({ log: silentLog, storeFile: file });
    expect(b.state.contacts.lig_contact_0001.version).toBe(1);
    expect(b.state.calls).toHaveLength(1);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('refuses an unknown mode', async () => {
    expect((await setMode('sometimes')).statusCode).toBe(400);
  });
});
