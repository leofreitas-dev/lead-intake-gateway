import type { Classifier } from './classifier.ts';
import { costUsd, type PriceList } from './pricing.ts';
import { buildRequest, type LeadForAi } from './prompt.ts';
import { type Classification, parseClassification } from './schema.ts';

export const MIN_CONFIDENCE = 0.7;
export const MAX_TRIES = 2;

export type CallOutcome = 'valid' | 'invalid' | 'refused' | 'no_recording';

/** One call to the model, kept for the record: tokens, cost, and whether the answer was usable. */
export interface AiCall {
  attempt: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  stopReason: string;
  outcome: CallOutcome;
  error: string | null;
}

export interface ClassifyResult {
  status: 'classified' | 'needs_review';
  /** What the AI said. Present even when a person must check it (low confidence). */
  classification: Classification | null;
  /** Why a person must check it; null when status is "classified". */
  reviewReason: string | null;
  calls: AiCall[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Asks the model to classify a lead and checks the answer.
 *
 * - An answer that is not valid JSON for the schema is asked again, once.
 *   Invalid twice → a person reviews it ("revisar à mão").
 * - A valid answer with confidence below MIN_CONFIDENCE → a person reviews it.
 * - A refusal, or no recorded answer in demo mode → a person reviews it (asking again would not help).
 * - Network and API errors are NOT handled here: they go up to the job queue,
 *   which retries later with backoff.
 */
export async function classifyLead(
  classifier: Classifier,
  prices: PriceList,
  lead: LeadForAi,
  { minConfidence = MIN_CONFIDENCE, maxTries = MAX_TRIES } = {},
): Promise<ClassifyResult> {
  const request = buildRequest(classifier.model, lead);
  const calls: AiCall[] = [];
  let classification: Classification | null = null;
  let reviewReason: string | null = null;

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const reply = await classifier.complete(request);
    const call: AiCall = {
      attempt,
      model: reply.model,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      costUsd: costUsd(prices, reply.model, reply),
      stopReason: reply.stopReason,
      outcome: 'valid',
      error: null,
    };
    calls.push(call);

    if (reply.stopReason === 'no_recording') {
      call.outcome = 'no_recording';
      reviewReason = 'no recorded AI answer for this lead (recorded mode: run with AI_MODE=live to ask the model)';
      break;
    }
    if (reply.stopReason === 'refusal') {
      call.outcome = 'refused';
      reviewReason = 'the model declined to classify this lead';
      break;
    }
    const parsed = parseClassification(reply.text ?? '');
    if (parsed.ok) {
      classification = parsed.value;
      break;
    }
    call.outcome = 'invalid';
    call.error = reply.stopReason === 'max_tokens' ? `cut off at max_tokens; ${parsed.error}` : parsed.error;
    if (attempt === maxTries) reviewReason = `the AI answer was invalid ${maxTries} times (last: ${call.error})`;
  }

  if (classification && classification.confidence < minConfidence) {
    reviewReason = `the AI is not sure: confidence ${classification.confidence.toFixed(2)} is below ${minConfidence.toFixed(2)}`;
  }

  return {
    status: reviewReason ? 'needs_review' : 'classified',
    classification,
    reviewReason,
    calls,
    inputTokens: sum(calls, 'inputTokens'),
    outputTokens: sum(calls, 'outputTokens'),
    costUsd: sum(calls, 'costUsd'),
  };
}

function sum(calls: AiCall[], field: 'inputTokens' | 'outputTokens' | 'costUsd'): number {
  return calls.reduce((n, c) => n + c[field], 0);
}
