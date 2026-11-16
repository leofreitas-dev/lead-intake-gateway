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
  /** Port of the embedded Postgres. Only used when `databaseUrl` is empty. */
  embeddedPgPort: number;
  logLevel: string;
  /** Human-friendly log lines instead of JSON. */
  logPretty: boolean;
  /** Jobs the worker runs at the same time. */
  workerConcurrency: number;
  gateway: GatewayConfig;
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
    embeddedPgPort: toPort(env.EMBEDDED_PG_PORT, 54329, 'EMBEDDED_PG_PORT'),
    logLevel: env.LOG_LEVEL || 'info',
    // Pretty in a terminal, JSON when piped to a file or a log tool. LOG_PRETTY overrides.
    logPretty: env.LOG_PRETTY ? env.LOG_PRETTY === '1' || env.LOG_PRETTY === 'true' : isTerminal,
    workerConcurrency: toPositiveInt(env.WORKER_CONCURRENCY, 4, 'WORKER_CONCURRENCY'),
    gateway: loadGatewayConfig(env),
  };
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
