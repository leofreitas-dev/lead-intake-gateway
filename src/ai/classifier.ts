import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ClassificationRequest } from './prompt.ts';
import { Classification } from './schema.ts';

/** One answer from the model, with what it cost in tokens. */
export interface ModelReply {
  /** The text the model wrote, or null if it wrote none. */
  text: string | null;
  /** Why it stopped: end_turn, max_tokens, refusal... or no_recording (recorded mode, unknown lead). */
  stopReason: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface Classifier {
  readonly mode: 'live' | 'recorded';
  readonly model: string;
  complete(request: ClassificationRequest): Promise<ModelReply>;
}

export const DEFAULT_MODEL = 'claude-haiku-5-5';

/**
 * Calls Claude for real. The API key comes from ANTHROPIC_API_KEY (read by the
 * SDK itself; this code never touches it). Network errors, 429 and 5xx are
 * retried twice by the SDK; after that the error goes up and the job queue
 * retries later with backoff.
 */
export class AnthropicClassifier implements Classifier {
  readonly mode = 'live';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(model: string = DEFAULT_MODEL, client?: Anthropic) {
    this.model = model;
    this.client = client ?? new Anthropic({ maxRetries: 2, timeout: 30_000 });
  }

  async complete(request: ClassificationRequest): Promise<ModelReply> {
    const response = await this.client.messages.create({
      model: this.model,
      // Room for a short JSON answer, plus some thinking if the model decides it needs it.
      max_tokens: 1024,
      // Classification is simple: low effort keeps tokens (and cost) down.
      output_config: { effort: 'low', format: zodOutputFormat(Classification) },
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    });
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return {
      text: text || null,
      stopReason: response.stop_reason ?? 'unknown',
      model: this.model, // the model we asked for, which is the one config/pricing.json prices
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}

export const RECORDINGS_FILE = path.resolve(import.meta.dirname, '../../fixtures/ai/recorded.json');

export interface Recording {
  fixture: string;
  text: string | null;
  stop_reason: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  recorded_at: string;
}

export interface RecordingsFile {
  about: string;
  model: string;
  recordings: Record<string, Recording>;
}

export function readRecordings(file = RECORDINGS_FILE): RecordingsFile {
  if (!fs.existsSync(file)) return { about: '', model: DEFAULT_MODEL, recordings: {} };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Replays real answers recorded earlier with `npm run ai:record`, so the demo
 * and the tests run with no key and no cost. Each recording is found by the
 * request key (model + prompt + lead): change the prompt and the old answer no
 * longer applies.
 */
export class RecordedClassifier implements Classifier {
  readonly mode = 'recorded';
  readonly model: string;
  private readonly recordings: Record<string, Recording>;

  constructor(file: string | RecordingsFile = RECORDINGS_FILE) {
    const data = typeof file === 'string' ? readRecordings(file) : file;
    this.model = data.model;
    this.recordings = data.recordings;
  }

  async complete(request: ClassificationRequest): Promise<ModelReply> {
    const r = this.recordings[request.key];
    if (!r) return { text: null, stopReason: 'no_recording', model: this.model, inputTokens: 0, outputTokens: 0 };
    return { text: r.text, stopReason: r.stop_reason, model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens };
  }
}
