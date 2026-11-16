import path from 'node:path';
import { SOURCES, type Source } from './sources.ts';

export interface Config {
  /** Port the HTTP server listens on. */
  port: number;
  /** Address the HTTP server binds to. 127.0.0.1 keeps the demo local-only. */
  host: string;
  /**
   * Connection string of an existing Postgres. When it is empty, the gateway
   * starts its own embedded Postgres under `dataDir`.
   */
  databaseUrl: string | undefined;
  /** Where the embedded Postgres keeps its files. */
  dataDir: string;
  /**
   * Port of the embedded Postgres. Only used when `databaseUrl` is empty.
   * Below 32768 on purpose: ports above it are handed out by the OS as the
   * source port of outgoing connections, and one of those can take the port
   * just before Postgres starts ("Address already in use").
   */
  embeddedPgPort: number;
  logLevel: string;
  /** Human-friendly log lines instead of JSON. */
  logPretty: boolean;
  /** Jobs the worker runs at the same time. */
  workerConcurrency: number;
  gateway: GatewayConfig;
  ai: AiConfig;
  crm: CrmConfig;
  admin: AdminConfig;
}

export interface CrmConfig {
  /** Where the CRM (the fake one, by default) answers. */
  url: string;
  /** A CRM call with no answer after this is a timeout (and retried). */
  timeoutMs: number;
  /** Our own limit on calls to the CRM, kept under the CRM's limit so we do not get 429. */
  rateLimitPerSec: number;
  rateLimitBurst: number;
  /** Attempts before a delivery goes to dead-letter. */
  maxAttempts: number;
  /** Backoff between attempts: base × 2^(attempt-1), up to max, with full jitter. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Failures in a row that open the circuit breaker. */
  breakerThreshold: number;
  /** How long the breaker stays open before one trial delivery. */
  breakerCooldownMs: number;
  /** Deliveries in flight at the same time. */
  concurrency: number;
}

export interface AdminConfig {
  /** Bearer token for the admin endpoints (GET /dead-letter, POST /replay). */
  token: string;
  usingDemoToken: boolean;
}

/** Published on purpose so the local demo works; refused with NODE_ENV=production. */
export const DEMO_ADMIN_TOKEN = 'demo-only-admin-token';

export interface AiConfig {
  /**
   * recorded (default): replays real answers saved in fixtures/ai/recorded.json; no key, no cost.
   * live: calls the Anthropic API with ANTHROPIC_API_KEY.
   */
  mode: 'live' | 'recorded';
  model: string;
  /** Below this confidence a person reviews the lead. */
  minConfidence: number;
}

export interface GatewayConfig {
  /** Shared secret per channel, used to check the HMAC signature of each webhook. */
  secrets: Record<Source, string>;
  /** True when at least one secret is a built-in demo value. */
  usingDemoSecrets: boolean;
  /** A signed webhook older (or newer) than this is refused, so a captured request cannot be replayed later. */
  signatureToleranceSec: number;
  /** Requests per second each caller may send to one channel, after the burst is used. */
  rateLimitPerSec: number;
  /** Requests a caller may send at once before the per-second limit applies. */
  rateLimitBurst: number;
  /** Largest webhook body accepted, in bytes. */
  bodyLimitBytes: number;
}

/**
 * Demo-only secrets, published on purpose so `npm run demo` works with no setup.
 * Real deployments set WEBHOOK_SECRET_<SOURCE>; with NODE_ENV=production these are refused.
 */
export const DEMO_SECRET_PREFIX = 'demo-only-secret-';

export function loadConfig(env: NodeJS.ProcessEnv = process.env, isTerminal = Boolean(process.stdout.isTTY)): Config {
  return {
    port: toPort(env.PORT, 3000, 'PORT'),
    host: env.HOST || '127.0.0.1',
    databaseUrl: env.DATABASE_URL || undefined,
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    embeddedPgPort: toPort(env.EMBEDDED_PG_PORT, 25432, 'EMBEDDED_PG_PORT'),
    logLevel: env.LOG_LEVEL || 'info',
    // Pretty in a terminal, JSON when piped to a file or a log tool. LOG_PRETTY overrides.
    logPretty: env.LOG_PRETTY ? env.LOG_PRETTY === '1' || env.LOG_PRETTY === 'true' : isTerminal,
    workerConcurrency: toPositiveInt(env.WORKER_CONCURRENCY, 4, 'WORKER_CONCURRENCY'),
    gateway: loadGatewayConfig(env),
    ai: loadAiConfig(env),
    crm: {
      url: env.CRM_URL || 'http://127.0.0.1:4010',
      timeoutMs: toPositiveInt(env.CRM_TIMEOUT_MS, 3_000, 'CRM_TIMEOUT_MS'),
      rateLimitPerSec: toPositiveInt(env.CRM_RATE_LIMIT_PER_SEC, 5, 'CRM_RATE_LIMIT_PER_SEC'),
      rateLimitBurst: toPositiveInt(env.CRM_RATE_LIMIT_BURST, 5, 'CRM_RATE_LIMIT_BURST'),
      maxAttempts: toPositiveInt(env.DELIVERY_MAX_ATTEMPTS, 10, 'DELIVERY_MAX_ATTEMPTS'),
      backoffBaseMs: toPositiveInt(env.DELIVERY_BACKOFF_BASE_MS, 1_000, 'DELIVERY_BACKOFF_BASE_MS'),
      backoffMaxMs: toPositiveInt(env.DELIVERY_BACKOFF_MAX_MS, 10 * 60_000, 'DELIVERY_BACKOFF_MAX_MS'),
      breakerThreshold: toPositiveInt(env.CIRCUIT_FAILURE_THRESHOLD, 5, 'CIRCUIT_FAILURE_THRESHOLD'),
      breakerCooldownMs: toPositiveInt(env.CIRCUIT_COOLDOWN_MS, 15_000, 'CIRCUIT_COOLDOWN_MS'),
      concurrency: toPositiveInt(env.DELIVERY_CONCURRENCY, 4, 'DELIVERY_CONCURRENCY'),
    },
    admin: loadAdminConfig(env),
  };
}

function loadAdminConfig(env: NodeJS.ProcessEnv): AdminConfig {
  const token = env.ADMIN_TOKEN;
  if (token) {
    if (token.length < 16) throw new Error('ADMIN_TOKEN must be at least 16 characters');
    return { token, usingDemoToken: false };
  }
  if (env.NODE_ENV === 'production') throw new Error('ADMIN_TOKEN is required when NODE_ENV=production');
  return { token: DEMO_ADMIN_TOKEN, usingDemoToken: true };
}

function loadAiConfig(env: NodeJS.ProcessEnv): AiConfig {
  const mode = env.AI_MODE || 'recorded';
  if (mode !== 'live' && mode !== 'recorded') throw new Error(`AI_MODE must be "live" or "recorded", got "${mode}"`);
  // Only checks that the key is there; the value is read by the Anthropic SDK and never stored or logged here.
  if (mode === 'live' && !env.ANTHROPIC_API_KEY) throw new Error('AI_MODE=live needs ANTHROPIC_API_KEY in .env');
  const minConfidence = env.AI_MIN_CONFIDENCE ? Number(env.AI_MIN_CONFIDENCE) : 0.7;
  if (!(minConfidence >= 0 && minConfidence <= 1)) throw new Error(`AI_MIN_CONFIDENCE must be between 0 and 1, got "${env.AI_MIN_CONFIDENCE}"`);
  return { mode, model: env.AI_MODEL || 'claude-haiku-5-5', minConfidence };
}

function loadGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const production = env.NODE_ENV === 'production';
  let usingDemoSecrets = false;
  const secrets = {} as Record<Source, string>;
  for (const source of SOURCES) {
    const name = `WEBHOOK_SECRET_${source.toUpperCase()}`;
    const value = env[name];
    if (value) {
      if (value.length < 16) throw new Error(`${name} must be at least 16 characters`);
      secrets[source] = value;
    } else if (production) {
      throw new Error(`${name} is required when NODE_ENV=production`);
    } else {
      secrets[source] = DEMO_SECRET_PREFIX + source;
      usingDemoSecrets = true;
    }
  }
  return {
    secrets,
    usingDemoSecrets,
    signatureToleranceSec: toPositiveInt(env.SIGNATURE_TOLERANCE_SEC, 300, 'SIGNATURE_TOLERANCE_SEC'),
    rateLimitPerSec: toPositiveInt(env.RATE_LIMIT_PER_SEC, 20, 'RATE_LIMIT_PER_SEC'),
    rateLimitBurst: toPositiveInt(env.RATE_LIMIT_BURST, 40, 'RATE_LIMIT_BURST'),
    bodyLimitBytes: toPositiveInt(env.BODY_LIMIT_BYTES, 256 * 1024, 'BODY_LIMIT_BYTES'),
  };
}

function toPositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number above 0, got "${value}"`);
  return n;
}

function toPort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a port number between 1 and 65535, got "${value}"`);
  }
  return port;
}
