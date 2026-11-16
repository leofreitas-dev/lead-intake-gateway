import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRecordings } from '../src/ai/classifier.ts';
import { buildRequest } from '../src/ai/prompt.ts';
import { buildApp } from '../src/app.ts';
import { migrate } from '../src/db/migrate.ts';
import { demoScript, loadFixture } from '../src/fixtures.ts';
import { signatureHeader } from '../src/gateway/signature.ts';
import { adapters } from '../src/leads/adapters.ts';
import { normalizeLead } from '../src/leads/normalize.ts';
import { processLead } from '../src/leads/process.ts';
import { drain } from '../src/queue/worker.ts';
import { createTestDatabase, silentLog, testGatewayConfig, type TestDatabase } from './helpers.ts';

describe('the Juniper Lane Realty demo script', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    const gateway = testGatewayConfig();
    const app = buildApp({ pool: db.pool, log: silentLog, gateway });
    for (const step of demoScript()) {
      const { body } = loadFixture(step.source, step.fixture);
      await app.inject({
        method: 'POST',
        url: `/webhooks/${step.source}`,
        payload: body,
        headers: { 'content-type': 'application/json', 'x-signature': signatureHeader(gateway.secrets[step.source], body) },
      });
    }
    await app.close();
    await drain({ pool: db.pool, log: silentLog, kind: 'process', handler: processLead });
  });
  afterAll(() => db.drop());

  const query = async (sql: string) => (await db.pool.query(sql)).rows;

  it('uses only fictional data: .test emails and 555-01xx phones', async () => {
    const leads = await query('select email, phone from leads');
    for (const { email, phone } of leads) {
      if (email) expect(email).toMatch(/\.test$/);
      if (phone) expect(phone).toMatch(/^\+1\d{3}55501\d{2}$/);
    }
  });

  it('13 webhooks: 1 resend and 1 broken payload, so 11 leads', async () => {
    expect(await query('select count(*)::int as n from inbox')).toEqual([{ n: 12 }]);
    expect(await query('select count(*)::int as n from leads')).toEqual([{ n: 11 }]);
    expect(await query(`select count(*)::int as n from jobs where status = 'done'`)).toEqual([{ n: 11 }]);
  });

  it('every lead was read without notes (all fields understood)', async () => {
    expect(await query(`select source, notes from leads where notes <> '[]'::jsonb`)).toEqual([]);
  });

  it('11 leads become 7 contacts', async () => {
    const contacts = await query(`
      select display_name, (select count(*)::int from leads l where l.contact_id = c.id) as leads
        from contacts c where merged_into is null order by display_name, leads desc`);
    expect(contacts).toEqual([
      { display_name: 'Daniel Brooks', leads: 3 },
      { display_name: 'Emily Carter', leads: 3 },
      { display_name: 'Emily Carter', leads: 1 },
      { display_name: 'Marcus', leads: 1 },
      { display_name: 'Olivia Grant', leads: 1 },
      { display_name: 'Sofía Ramírez', leads: 1 },
      { display_name: 'Top SEO Agency', leads: 1 },
    ]);
  });

  it('Emily by form, WhatsApp and portal is one contact with one phone in E.164', async () => {
    const rows = await query(`
      select l.source, l.phone_raw, l.phone from leads l
       where l.contact_id = (select contact_id from contact_identifiers where kind = 'email' and value = 'emily.carter@example.test')
       order by l.occurred_at`);
    expect(rows).toEqual([
      { source: 'form', phone_raw: '(212) 555-0147', phone: '+12125550147' },
      { source: 'whatsapp', phone_raw: '12125550147', phone: '+12125550147' },
      { source: 'portal', phone_raw: '+1 212.555.0147', phone: '+12125550147' },
    ]);
  });

  it('Daniel and "Dan B" were merged once, with the reason on the timeline', async () => {
    const merges = await query(`select detail from contact_events where kind = 'merged'`);
    expect(merges).toHaveLength(1);
    expect(merges[0].detail.absorbed_name).toBe('Dan B');
  });
});

describe('recorded AI answers', () => {
  it('every demo lead has a real recorded answer for the current prompt, with its tokens', () => {
    const file = readRecordings();
    const fixtures = new Set<string>();
    for (const step of demoScript()) {
      if (step.fixture.startsWith('broken')) continue;
      const lead = normalizeLead((adapters as any)[step.source](JSON.parse(loadFixture(step.source as any, step.fixture).body)));
      const r = file.recordings[buildRequest(file.model, { source: step.source, message: lead.message, listingRef: lead.listingRef }).key];
      expect(r, `no recording for ${step.fixture}: run npm run ai:record`).toBeDefined();
      expect(r.fixture).toBe(step.fixture);
      expect(r.input_tokens).toBeGreaterThan(0);
      fixtures.add(step.fixture);
    }
    expect(fixtures.size).toBe(11);
    expect(JSON.stringify(file)).not.toMatch(/sk-ant/);
  });
});
