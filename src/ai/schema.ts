import { z } from 'zod';

/**
 * What the AI must answer about a lead. The AI only fills this in; the route is
 * decided by code (src/routing/rules.ts) from these fields.
 */
export const INTENTS = ['buy', 'sell', 'rent', 'vendor', 'spam', 'other'] as const;
export const URGENCIES = ['low', 'medium', 'high'] as const;
export const BUDGET_BANDS = [
  'not_stated',
  'rent_under_3k_month',
  'rent_3k_plus_month',
  'buy_under_500k',
  'buy_500k_to_1m',
  'buy_over_1m',
] as const;

/** How a budget band is shown to people (the demo and the console). */
export const BUDGET_LABELS: Record<(typeof BUDGET_BANDS)[number], string> = {
  not_stated: 'no budget',
  rent_under_3k_month: '<$3k/mo',
  rent_3k_plus_month: '$3k+/mo',
  buy_under_500k: '<$500k',
  buy_500k_to_1m: '$500k–1M',
  buy_over_1m: '$1M+',
};

export const Classification = z
  .object({
    intent: z.enum(INTENTS),
    urgency: z.enum(URGENCIES),
    budget_band: z.enum(BUDGET_BANDS),
    /** ISO 639-1 code of the language the person wrote in, e.g. "en", "es". */
    language: z.string().regex(/^[a-z]{2}$/, 'a two-letter ISO 639-1 code'),
    /** 0 to 1: how sure the model is about intent and urgency together. */
    confidence: z.number().min(0).max(1),
    /** One short sentence a human can check: why these values. */
    evidence: z.string().min(1).max(300),
  })
  .strict();

export type Classification = z.infer<typeof Classification>;

export type ParseResult = { ok: true; value: Classification } | { ok: false; error: string };

/** Parses the model's text: it must be JSON, and the JSON must match the schema exactly. */
export function parseClassification(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  const result = Classification.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return { ok: false, error: issues.join('; ') };
}
