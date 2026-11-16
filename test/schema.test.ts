import { describe, expect, it } from 'vitest';
import { costUsd, loadPriceList } from '../src/ai/pricing.ts';
import { parseClassification } from '../src/ai/schema.ts';

const valid = {
  intent: 'buy',
  urgency: 'high',
  budget_band: 'buy_500k_to_1m',
  language: 'en',
  confidence: 0.92,
  evidence: 'Wants to see the house on Saturday; budget around $650k.',
};

describe('parseClassification', () => {
  it('accepts a reply that matches the schema', () => {
    expect(parseClassification(JSON.stringify(valid))).toEqual({ ok: true, value: valid });
  });

  it('refuses text that is not JSON', () => {
    expect(parseClassification('Sure! Here is the JSON: {"intent": "buy"')).toEqual({ ok: false, error: 'not JSON' });
  });

  it('refuses a value outside the lists', () => {
    const r = parseClassification(JSON.stringify({ ...valid, intent: 'purchase' }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^intent:/);
  });

  it('refuses a confidence outside 0..1 and a language that is not a 2-letter code', () => {
    const r = parseClassification(JSON.stringify({ ...valid, confidence: 92, language: 'English' }));
    expect(!r.ok && r.error).toMatch(/confidence/);
    expect(!r.ok && r.error).toMatch(/language/);
  });

  it('refuses a missing field and an extra field', () => {
    const { evidence: _, ...missing } = valid;
    expect(parseClassification(JSON.stringify(missing)).ok).toBe(false);
    expect(parseClassification(JSON.stringify({ ...valid, route: 'agent' })).ok).toBe(false);
  });

  it('refuses JSON that is not an object', () => {
    expect(parseClassification('["buy"]').ok).toBe(false);
    expect(parseClassification('null').ok).toBe(false);
  });
});

describe('price list', () => {
  it('has the Haiku price, its source and the date it was checked', () => {
    const prices = loadPriceList();
    expect(prices.models['claude-haiku-5-5']).toEqual({ input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.5 });
    expect(prices.source).toMatch(/^https:\/\/platform\.claude\.com\/docs\/.+pricing/);
    expect(prices.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('computes the cost of a call from its tokens', () => {
    const prices = loadPriceList();
    // 1M input tokens at $0.10 + 1M output tokens at $0.50
    expect(costUsd(prices, 'claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.6, 10);
    expect(costUsd(prices, 'claude-haiku-5-5', { inputTokens: 500, outputTokens: 80 })).toBeCloseTo(0.00009, 10);
  });

  it('refuses to price a model it does not know, instead of saying it was free', () => {
    expect(() => costUsd(loadPriceList(), 'some-other-model', { inputTokens: 1, outputTokens: 1 })).toThrow(/no price/);
  });
});
