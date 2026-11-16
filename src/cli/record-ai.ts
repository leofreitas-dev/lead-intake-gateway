// npm run ai:record: asks Claude ONCE per demo lead and saves the real answers
// (with their token counts) in fixtures/ai/recorded.json. The demo and the
// tests replay them, so they run with no key and no cost.
//
//   npm run ai:record -- --dry-run   shows what would be sent, calls nothing
//   npm run ai:record                calls the API only for leads not recorded yet
//   npm run ai:record -- --force     records every lead again
import fs from 'node:fs';
import { AnthropicClassifier, DEFAULT_MODEL, readRecordings, RECORDINGS_FILE, type RecordingsFile } from '../ai/classifier.ts';
import { costUsd, loadPriceList } from '../ai/pricing.ts';
import { buildRequest } from '../ai/prompt.ts';
import { parseClassification } from '../ai/schema.ts';
import { loadDotEnv } from '../env.ts';
import { demoScript, loadFixture } from '../fixtures.ts';
import { adapters } from '../leads/adapters.ts';
import { normalizeLead } from '../leads/normalize.ts';
import { isSource } from '../sources.ts';

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
loadDotEnv();
const model = process.env.AI_MODEL || DEFAULT_MODEL;
if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Put it in .env (never in the code), or use --dry-run.');
  process.exit(1);
}

const prices = loadPriceList();
const existing = readRecordings();
const out: RecordingsFile = {
  about:
    'Real answers from Claude for the demo leads, recorded with `npm run ai:record` (one call per lead). ' +
    'The demo replays them: no key, no cost. Found by request key = sha256(model, system prompt, lead message).',
  model,
  recordings: force || existing.model !== model ? {} : { ...existing.recordings },
};
const classifier = new AnthropicClassifier(model);

// Every distinct lead of the demo, once (the resend and the broken payload are skipped).
const seen = new Set<string>();
let calls = 0;
let input = 0;
let output = 0;
for (const step of demoScript()) {
  if (seen.has(step.fixture) || !isSource(step.source)) continue;
  seen.add(step.fixture);
  const { body } = loadFixture(step.source, step.fixture);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    continue; // the broken payload never becomes a lead
  }
  const lead = normalizeLead(adapters[step.source](parsed as never));
  const request = buildRequest(model, { source: step.source, message: lead.message, listingRef: lead.listingRef });

  if (out.recordings[request.key]) {
    console.log(`${step.fixture.padEnd(8)} already recorded, skipped`);
    continue;
  }
  if (dryRun) {
    console.log(`${step.fixture.padEnd(8)} would call ${model} (key ${request.key})\n${indent(request.user)}`);
    continue;
  }

  const reply = await classifier.complete(request);
  calls++;
  input += reply.inputTokens;
  output += reply.outputTokens;
  out.recordings[request.key] = {
    fixture: step.fixture,
    text: reply.text,
    stop_reason: reply.stopReason,
    model: reply.model,
    input_tokens: reply.inputTokens,
    output_tokens: reply.outputTokens,
    recorded_at: new Date().toISOString(),
  };
  const check = parseClassification(reply.text ?? '');
  const cost = costUsd(prices, reply.model, reply);
  const what = check.ok
    ? `${check.value.intent}/${check.value.urgency}/${check.value.language} confidence ${check.value.confidence}`
    : `INVALID: ${check.error}`;
  console.log(`${step.fixture.padEnd(8)} ${String(reply.inputTokens).padStart(4)} in ${String(reply.outputTokens).padStart(4)} out  $${cost.toFixed(6)}  ${what}`);
  // Save after every call, so a failure halfway keeps what was already paid for.
  fs.writeFileSync(RECORDINGS_FILE, JSON.stringify(out, null, 2) + '\n');
}

if (!dryRun) {
  const cost = costUsd(prices, model, { inputTokens: input, outputTokens: output });
  console.log(`\n${calls} calls to ${model}: ${input} input + ${output} output tokens = $${cost.toFixed(6)}`);
  console.log(`(prices from config/pricing.json, checked ${prices.checkedOn})`);
}

function indent(s: string) {
  return s.replace(/^/gm, '    ');
}
