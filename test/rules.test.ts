import { describe, expect, it } from 'vitest';
import type { Classification } from '../src/ai/schema.ts';
import { decideRoute, RULES } from '../src/routing/rules.ts';

const base: Classification = { intent: 'buy', urgency: 'medium', budget_band: 'not_stated', language: 'en', confidence: 0.9, evidence: 'test' };
const route = (c: Partial<Classification>) => decideRoute({ status: 'classified', classification: { ...base, ...c }, reviewReason: null });

describe('decideRoute', () => {
  it('spam → archive', () => {
    expect(route({ intent: 'spam' })).toMatchObject({ route: 'archive', rule: 'spam' });
  });

  it('spam stays spam whatever its urgency or language', () => {
    expect(route({ intent: 'spam', urgency: 'high', language: 'es' }).route).toBe('archive');
  });

  it('vendor → general inbox', () => {
    expect(route({ intent: 'vendor', urgency: 'high' })).toMatchObject({ route: 'general_inbox', rule: 'vendor' });
  });

  it('buy or sell with high urgency → on-call agent', () => {
    expect(route({ intent: 'buy', urgency: 'high' })).toMatchObject({ route: 'on_call_agent', rule: 'urgent-buyer-or-seller' });
    expect(route({ intent: 'sell', urgency: 'high' }).route).toBe('on_call_agent');
  });

  it('rent with high urgency is NOT the on-call agent: it goes to the rentals desk', () => {
    expect(route({ intent: 'rent', urgency: 'high' }).route).toBe('rentals_desk');
  });

  it('buy, sell, rent without high urgency → their team', () => {
    expect(route({ intent: 'buy', urgency: 'low' }).route).toBe('buyer_team');
    expect(route({ intent: 'sell', urgency: 'medium' }).route).toBe('listing_team');
    expect(route({ intent: 'rent', urgency: 'medium' }).route).toBe('rentals_desk');
  });

  it('Spanish → the Spanish-speaking agent, even when urgent', () => {
    const d = route({ intent: 'buy', urgency: 'high', language: 'es' });
    expect(d).toMatchObject({ route: 'spanish_agent', rule: 'language-with-agent' });
    expect(d.reason).toBe('written in Spanish: goes to an agent who speaks it');
  });

  it('a language nobody speaks → manual review, saying which language', () => {
    expect(route({ language: 'pt' })).toMatchObject({ route: 'manual_review', reason: 'written in Portuguese and no agent speaks it: a person decides' });
  });

  it('other → general inbox', () => {
    expect(route({ intent: 'other' }).route).toBe('general_inbox');
  });

  it('needs review → manual review, with the reason from the classification', () => {
    const d = decideRoute({ status: 'needs_review', classification: { ...base, confidence: 0.4 }, reviewReason: 'the AI is not sure: confidence 0.40 is below 0.70' });
    expect(d).toEqual({ route: 'manual_review', rule: 'needs-review', reason: 'the AI is not sure: confidence 0.40 is below 0.70' });
  });

  it('a low-confidence spam is NOT archived: a person checks it first', () => {
    expect(decideRoute({ status: 'needs_review', classification: { ...base, intent: 'spam', confidence: 0.5 }, reviewReason: 'unsure' }).route).toBe('manual_review');
  });

  it('every combination gets exactly one route and a reason', () => {
    for (const intent of ['buy', 'sell', 'rent', 'vendor', 'spam', 'other'] as const)
      for (const urgency of ['low', 'medium', 'high'] as const)
        for (const language of ['en', 'es', 'fr']) {
          const d = route({ intent, urgency, language });
          expect(d.reason.length).toBeGreaterThan(5);
          expect(RULES.map((r) => r.name)).toContain(d.rule);
        }
  });
});
