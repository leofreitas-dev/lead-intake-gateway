import { describe, expect, it } from 'vitest';
import type { ModelReply } from '../src/ai/classifier.ts';
import { amounts, buildDraftRequest, checkDraft, type Drafter, fillFirstName, firstNameOf, timeMentions, wantsDraft, writeDraft } from '../src/ai/draft.ts';
import { loadPriceList } from '../src/ai/pricing.ts';
import { RecordedClassifier } from '../src/ai/classifier.ts';
import { classifyLead } from '../src/ai/classify.ts';
import { RecordedDrafter } from '../src/ai/draft.ts';
import { demoScript, loadFixture } from '../src/fixtures.ts';
import { adapters } from '../src/leads/adapters.ts';
import { normalizeLead } from '../src/leads/normalize.ts';
import { decideRoute } from '../src/routing/rules.ts';
import { isSource } from '../src/sources.ts';

const prices = loadPriceList();

describe('the recorded drafts (fixtures/ai/drafts.json)', () => {
  it('cover every demo lead that gets a draft, and every one passes the guard', async () => {
    const classifier = new RecordedClassifier();
    const drafter = new RecordedDrafter();
    const seen = new Set<string>();
    const results: Record<string, string> = {};
    for (const step of demoScript()) {
      if (seen.has(step.fixture) || !isSource(step.source) || step.fixture.startsWith('broken')) continue;
      seen.add(step.fixture);
      const lead = normalizeLead(adapters[step.source](JSON.parse(loadFixture(step.source, step.fixture).body) as never));
      const forAi = { source: step.source, message: lead.message, listingRef: lead.listingRef };
      const classified = await classifyLead(classifier, prices, forAi);
      const { route } = decideRoute(classified);
      const c = classified.classification;
      if (!c || !wantsDraft(route, c.intent)) {
        results[step.fixture] = `no draft (${route})`;
        continue;
      }
      const r = await writeDraft(drafter, prices, { ...forAi, route, classification: c });
      results[step.fixture] = r.status === 'ready' ? `ready (${r.draft!.language})` : `blocked: ${r.problems.join('; ')}`;
    }
    expect(results).toEqual({
      'lead-01': 'ready (en)', 'lead-02': 'no draft (manual_review)', 'lead-03': 'ready (en)', 'lead-04': 'ready (en)',
      'lead-05': 'no draft (archive)', 'lead-06': 'no draft (general_inbox)', 'lead-07': 'ready (es)', 'lead-08': 'ready (en)',
      'lead-09': 'ready (en)', 'lead-10': 'ready (en)', 'lead-11': 'ready (en)',
    });
  });
});
const input = {
  source: 'form',
  message: "Hi! I'm interested in the 3-bedroom on Maple Ave. Our budget is around $650k. Could we see it this Saturday?",
  listingRef: 'JLR-1042',
  route: 'on_call_agent',
  classification: { intent: 'buy' as const, urgency: 'high' as const, language: 'en' },
};
const good = 'Hi {first_name}, thank you for your interest in the 3-bedroom on Maple Ave. One of our agents will contact you shortly to talk about it and confirm the details of a visit. Is there anything else you are looking for in a home? Juniper Lane Realty';

/** A model stand-in that answers from a list, one answer per call. */
function scripted(...texts: (string | null)[]): Drafter & { calls: number } {
  return {
    mode: 'recorded',
    model: 'claude-haiku-5-5',
    calls: 0,
    async complete(): Promise<ModelReply> {
      const text = texts[Math.min(this.calls++, texts.length - 1)];
      return { text, stopReason: 'end_turn', model: 'claude-haiku-5-5', inputTokens: 300, outputTokens: 80 };
    },
  };
}
const json = (body: string, language = 'en') => JSON.stringify({ language, body });

describe('who gets a reply draft', () => {
  it('buyers, sellers and renters on a sales route; never spam, vendors or leads a person must review', () => {
    expect(wantsDraft('on_call_agent', 'buy')).toBe(true);
    expect(wantsDraft('spanish_agent', 'rent')).toBe(true);
    expect(wantsDraft('archive', 'spam')).toBe(false);
    expect(wantsDraft('general_inbox', 'vendor')).toBe(false);
    expect(wantsDraft('manual_review', 'buy')).toBe(false);
    expect(wantsDraft('spanish_agent', 'vendor')).toBe(false);
  });
});

describe('the draft guard (code, not AI)', () => {
  it('lets a careful reply through', () => {
    expect(checkDraft(good, input.message)).toEqual([]);
  });

  it('reads amounts in their usual forms', () => {
    expect(amounts('around $650k, up to $650,000, 2,500 dollars, $1.2M')).toEqual([650_000, 650_000, 2_500, 1_200_000]);
  });

  it('refuses a price the lead did not state; repeating the lead\'s own budget is fine', () => {
    expect(checkDraft('Hi {first_name}, the home is listed at $699,000.', input.message)).toContain('mentions an amount the lead did not: 699000');
    expect(checkDraft('Hi {first_name}, we noted your budget of $650,000.', input.message)).toEqual([]);
  });

  it('refuses a day or time the lead did not ask for; the lead\'s own day is fine', () => {
    expect(timeMentions('See you Saturday at 10am or 3:30 pm')).toEqual(['10am', '3:30pm', 'saturday']);
    expect(checkDraft('Hi {first_name}, we can show it to you Sunday at 11am.', input.message)).toEqual([
      'mentions a day or time the lead did not: "11am"',
      'mentions a day or time the lead did not: "sunday"',
    ]);
    expect(checkDraft('Hi {first_name}, the agent will confirm whether Saturday works.', input.message)).toEqual([]);
  });

  it('refuses claims of availability or inventory, in English and Spanish', () => {
    expect(checkDraft('Hi {first_name}, good news: it is still available!', input.message)).toContain('claims availability or inventory the system does not know');
    expect(checkDraft('Hi {first_name}, we have several condos that fit.', input.message)).toContain('claims availability or inventory the system does not know');
    expect(checkDraft('Hola {first_name}, el apartamento está disponible.', null)).toContain('claims availability or inventory the system does not know');
    expect(checkDraft('Hola {first_name}, tenemos varias opciones para usted.', null)).toContain('claims availability or inventory the system does not know');
  });

  it('refuses links, emails, phone numbers and unknown placeholders', () => {
    expect(checkDraft('Hi {first_name}, see www.example.test or write to a@b.test or call (212) 555-0100. {agent_name}', null)).toEqual([
      'contains a link',
      'contains an email address',
      'contains a phone number',
      'has a placeholder other than {first_name}',
    ]);
  });
});

describe('first name', () => {
  it('fills it in, or takes the placeholder out cleanly', () => {
    expect(fillFirstName('Hi {first_name}, thanks!', 'Emily')).toBe('Hi Emily, thanks!');
    expect(fillFirstName('Hi {first_name}, thanks!', null)).toBe('Hi, thanks!');
    expect(fillFirstName('Hola {first_name}:', null)).toBe('Hola:');
  });
  it('takes the first word of a person\'s name only', () => {
    expect(firstNameOf('Dan B')).toBe('Dan');
    expect(firstNameOf('Sofía Ramírez')).toBe('Sofía');
    expect(firstNameOf('growth@seo.test')).toBeNull();
    expect(firstNameOf(null)).toBeNull();
  });
});

describe('writing a draft', () => {
  it('a good answer is ready on the first call, with its tokens and cost', async () => {
    const model = scripted(json(good));
    const r = await writeDraft(model, prices, input);
    expect(r).toMatchObject({ status: 'ready', problems: [], inputTokens: 300, outputTokens: 80 });
    expect(r.draft?.body).toBe(good);
    expect(r.costUsd).toBeCloseTo((300 * 0.1 + 80 * 0.5) / 1e6, 12);
  });

  it('a draft that breaks a rule is asked again once; still bad → blocked, a person writes it', async () => {
    const bad = json('Hi {first_name}, it is still available at $699,000. Come Sunday at 11am!');
    const fixed = scripted(bad, json(good));
    expect(await writeDraft(fixed, prices, input)).toMatchObject({ status: 'ready' });
    expect(fixed.calls).toBe(2);
    const stubborn = scripted(bad, bad);
    const r = await writeDraft(stubborn, prices, input);
    expect(r.status).toBe('blocked');
    expect(r.draft).toBeNull();
    expect(r.problems).toContain('claims availability or inventory the system does not know');
    expect(r.calls.map((c) => c.outcome)).toEqual(['invalid', 'invalid']);
  });

  it('invalid JSON is asked again; no recording → blocked at once', async () => {
    expect(await writeDraft(scripted('not json', json(good)), prices, input)).toMatchObject({ status: 'ready' });
    const none: Drafter = { mode: 'recorded', model: 'claude-haiku-5-5', complete: async () => ({ text: null, stopReason: 'no_recording', model: 'claude-haiku-5-5', inputTokens: 0, outputTokens: 0 }) };
    const r = await writeDraft(none, prices, input);
    expect(r).toMatchObject({ status: 'blocked', calls: [expect.objectContaining({ outcome: 'no_recording' })] });
  });

  it('the AI gets no name, email or phone, and the reply language is spelled out', () => {
    const req = buildDraftRequest('claude-haiku-5-5', { ...input, classification: { ...input.classification, language: 'es' } });
    expect(req.user).toContain('Reply language: Spanish (es)');
    expect(req.user).not.toMatch(/Emily|@|555/);
  });
});
