import { describe, expect, it } from 'vitest';
import { makePlan } from '../src/chaos/plan.ts';
import { adapters } from '../src/leads/adapters.ts';
import { normalizeLead } from '../src/leads/normalize.ts';

describe('the chaos plan', () => {
  const plan = makePlan({ seed: 1 });

  it('is the same for the same seed, so runs can be compared', () => {
    const again = makePlan({ seed: 1 });
    expect(again.sends.map((s) => s.body)).toEqual(plan.sends.map((s) => s.body));
    expect(makePlan({ seed: 2 }).sends.map((s) => s.body)).not.toEqual(plan.sends.map((s) => s.body));
  });

  it('uses only fictional data, and the gateway reads every lead as planned', () => {
    for (const lead of plan.leads) {
      const n = normalizeLead((adapters as any)[lead.source](JSON.parse(lead.body)));
      if (n.email) expect(n.email).toMatch(/@chaos\.example\.test$/);
      if (n.phone) expect(n.phone).toMatch(/^\+1\d{3}55501\d{2}$/);
      const keys = [n.email && `e:${n.email}`, n.phone && `p:${n.phone}`].filter(Boolean);
      expect(keys.sort()).toEqual([...lead.keys].sort());
      expect(n.notes).toEqual([]);
    }
  });

  it('has resends (same body and event id as their original) and unique originals', () => {
    const resends = plan.sends.filter((s) => s.resendOf !== undefined);
    expect(resends.length).toBeGreaterThan(20);
    for (const r of resends) {
      const original = plan.leads.find((l) => l.n === r.resendOf)!;
      expect([r.body, r.eventId]).toEqual([original.body, original.eventId]);
    }
    expect(new Set(plan.leads.map((l) => l.body)).size).toBe(plan.leads.length);
    expect(plan.sends.length).toBe(plan.leads.length + resends.length);
  });

  it('expects one contact per group of linked identifiers; spam-only groups stay out of the CRM', () => {
    const leadsInGroups = plan.groups.reduce((n, g) => n + g.leadCount, 0);
    expect(leadsInGroups).toBe(plan.leads.length);
    for (const lead of plan.leads) {
      const groups = new Set(lead.keys.map((k) => plan.groupOfKey.get(k)));
      expect(groups.size).toBe(1);
    }
    expect(plan.groups.filter((g) => !g.delivered)).toHaveLength(8);
  });
});
