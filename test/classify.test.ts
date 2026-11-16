import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicClassifier, type Classifier, type ModelReply, RecordedClassifier } from '../src/ai/classifier.ts';
import { classifyLead } from '../src/ai/classify.ts';
import { loadPriceList } from '../src/ai/pricing.ts';
import { buildRequest, type LeadForAi } from '../src/ai/prompt.ts';

const prices = loadPriceList();
const lead: LeadForAi = { source: 'form', message: 'Could we see the 3-bedroom on Maple Ave this Saturday? Budget $650k.', listingRef: 'JLR-1042' };
const good = { intent: 'buy', urgency: 'high', budget_band: 'buy_500k_to_1m', language: 'en', confidence: 0.93, evidence: 'Wants a Saturday viewing; $650k.' };

/** A stand-in for the model: answers from a script, one reply per call. No network. */
function scripted(...replies: Partial<ModelReply>[]): Classifier & { calls: number } {
  let i = 0;
  return {
    mode: 'live',
    model: 'claude-haiku-5-5',
    calls: 0,
    async complete() {
      this.calls++;
      const r = replies[Math.min(i++, replies.length - 1)];
      return { text: null, stopReason: 'end_turn', model: 'claude-haiku-5-5', inputTokens: 400, outputTokens: 60, ...r };
    },
  };
}
const json = (o: object) => JSON.stringify(o);

describe('classifyLead', () => {
  it('a valid, confident answer is accepted after one call, with tokens and cost', async () => {
    const ai = scripted({ text: json(good) });
    const r = await classifyLead(ai, prices, lead);
    expect(r.status).toBe('classified');
    expect(r.classification).toEqual(good);
    expect(r.reviewReason).toBeNull();
    expect(ai.calls).toBe(1);
    expect(r).toMatchObject({ inputTokens: 400, outputTokens: 60 });
    expect(r.costUsd).toBeCloseTo((400 * 0.1 + 60 * 0.5) / 1e6, 12);
  });

  it('an invalid answer is asked again once; the second, valid one is used', async () => {
    const ai = scripted({ text: 'Here you go: buy, high urgency' }, { text: json(good) });
    const r = await classifyLead(ai, prices, lead);
    expect(r.status).toBe('classified');
    expect(r.calls.map((c) => c.outcome)).toEqual(['invalid', 'valid']);
    expect(r.calls[0].error).toBe('not JSON');
    // Both calls were paid for, so both count.
    expect(r.inputTokens).toBe(800);
  });

  it('invalid twice → manual review, and no third call', async () => {
    const ai = scripted({ text: json({ ...good, intent: 'purchase' }) }, { text: json({ ...good, confidence: 93 }) });
    const r = await classifyLead(ai, prices, lead);
    expect(ai.calls).toBe(2);
    expect(r.status).toBe('needs_review');
    expect(r.classification).toBeNull();
    expect(r.reviewReason).toMatch(/invalid 2 times/);
    expect(r.reviewReason).toMatch(/confidence/);
  });

  it('an answer cut off by max_tokens counts as invalid', async () => {
    const ai = scripted({ text: '{"intent": "bu', stopReason: 'max_tokens' });
    const r = await classifyLead(ai, prices, lead);
    expect(r.status).toBe('needs_review');
    expect(r.calls[1].error).toMatch(/max_tokens/);
  });

  it('low confidence → manual review, keeping what the AI said for the person to check', async () => {
    const ai = scripted({ text: json({ ...good, confidence: 0.55 }) });
    const r = await classifyLead(ai, prices, lead);
    expect(r.status).toBe('needs_review');
    expect(r.classification?.intent).toBe('buy');
    expect(r.reviewReason).toBe('the AI is not sure: confidence 0.55 is below 0.70');
  });

  it('exactly at the threshold is enough', async () => {
    const r = await classifyLead(scripted({ text: json({ ...good, confidence: 0.7 }) }), prices, lead);
    expect(r.status).toBe('classified');
  });

  it('a refusal → manual review at once (asking again would not help)', async () => {
    const ai = scripted({ text: null, stopReason: 'refusal' });
    const r = await classifyLead(ai, prices, lead);
    expect(ai.calls).toBe(1);
    expect(r.status).toBe('needs_review');
    expect(r.calls[0].outcome).toBe('refused');
  });

  it('an API error is not swallowed: it goes up to the job queue, which retries later', async () => {
    const ai: Classifier = { mode: 'live', model: 'claude-haiku-5-5', complete: async () => { throw new Error('529 overloaded'); } };
    await expect(classifyLead(ai, prices, lead)).rejects.toThrow('529 overloaded');
  });
});

describe('RecordedClassifier', () => {
  const request = buildRequest('claude-haiku-5-5', lead);
  const file = {
    about: 'test',
    model: 'claude-haiku-5-5',
    recordings: {
      [request.key]: { fixture: 'lead-01', text: json(good), stop_reason: 'end_turn', model: 'claude-haiku-5-5', input_tokens: 512, output_tokens: 70, recorded_at: '2026-11-16T12:00:00Z' },
    },
  };

  it('replays the recorded answer and its real token counts', async () => {
    const r = await classifyLead(new RecordedClassifier(file), prices, lead);
    expect(r.status).toBe('classified');
    expect(r).toMatchObject({ inputTokens: 512, outputTokens: 70 });
  });

  it('a lead with no recording goes to manual review, costs nothing and is not asked twice', async () => {
    const r = await classifyLead(new RecordedClassifier(file), prices, { ...lead, message: 'Something new' });
    expect(r.status).toBe('needs_review');
    expect(r.calls).toHaveLength(1);
    expect(r.costUsd).toBe(0);
    expect(r.reviewReason).toMatch(/no recorded AI answer/);
  });

  it('the key changes when the model, the prompt or the lead changes', () => {
    expect(buildRequest('claude-haiku-5-5', lead).key).toBe(request.key);
    expect(buildRequest('another-model', lead).key).not.toBe(request.key);
    expect(buildRequest('claude-haiku-5-5', { ...lead, listingRef: null }).key).not.toBe(request.key);
  });
});

describe('AnthropicClassifier (fake HTTP, no network, no key)', () => {
  it('sends Haiku, low effort, the JSON schema, and no personal data', async () => {
    let sent: any;
    const fetch = async (_url: any, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(
        json({
          id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
          content: [{ type: 'text', text: json(good) }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 431, output_tokens: 66 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const client = new Anthropic({ apiKey: 'not-a-real-key', fetch, maxRetries: 0 });
    const reply = await new AnthropicClassifier('claude-haiku-5-5', client).complete(
      buildRequest('claude-haiku-5-5', { ...lead, message: 'Hi, I am Emily Carter, emily.carter@example.test, (212) 555-0147. Saturday?' }),
    );

    expect(reply).toEqual({ text: json(good), stopReason: 'end_turn', model: 'claude-haiku-5-5', inputTokens: 431, outputTokens: 66 });
    expect(sent.model).toBe('claude-haiku-5-5');
    expect(sent.output_config.effort).toBe('low');
    expect(sent.output_config.format.type).toBe('json_schema');
    expect(sent.output_config.format.schema.required).toContain('confidence');
    expect(sent).not.toHaveProperty('temperature');
    // The lead's own words go as they are, but the adapter fields (name, email, phone) are never added.
    expect(sent.messages[0].content).not.toMatch(/^Name:|^Email:|^Phone:/m);
    expect(sent.system).toMatch(/not instructions to you/);
  });
});
