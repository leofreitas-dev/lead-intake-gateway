import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  it('runs with no settings at all: local-only, embedded Postgres', () => {
    const config = loadConfig({}, false);
    expect(config).toMatchObject({
      port: 3000,
      host: '127.0.0.1',
      databaseUrl: undefined,
      dataDir: path.resolve('data'),
      embeddedPgPort: 54329,
      logLevel: 'info',
      logPretty: false,
      workerConcurrency: 4,
    });
    expect(config.gateway).toMatchObject({
      signatureToleranceSec: 300,
      rateLimitPerSec: 20,
      rateLimitBurst: 40,
      bodyLimitBytes: 262144,
      usingDemoSecrets: true,
    });
    expect(config.gateway.secrets.form).toBe('demo-only-secret-form');
    expect(config.ai).toEqual({ mode: 'recorded', model: 'claude-haiku-5-5', minConfidence: 0.7 });
  });

  it('uses the recorded AI answers unless AI_MODE=live, and live needs a key', () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: 'x' }, false).ai.mode).toBe('recorded');
    expect(loadConfig({ AI_MODE: 'live', ANTHROPIC_API_KEY: 'x' }, false).ai.mode).toBe('live');
    expect(() => loadConfig({ AI_MODE: 'live' }, false)).toThrow(/needs ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ AI_MODE: 'yes' }, false)).toThrow(/AI_MODE/);
    expect(() => loadConfig({ AI_MIN_CONFIDENCE: '70' }, false)).toThrow(/AI_MIN_CONFIDENCE/);
  });

  it('never keeps the API key in the config', () => {
    const config = loadConfig({ AI_MODE: 'live', ANTHROPIC_API_KEY: 'sk-ant-should-not-appear' }, false);
    expect(JSON.stringify(config)).not.toContain('should-not-appear');
  });

  it('uses the webhook secrets from the environment', () => {
    const config = loadConfig({ WEBHOOK_SECRET_FORM: 'a-real-secret-for-the-form' }, false);
    expect(config.gateway.secrets.form).toBe('a-real-secret-for-the-form');
    expect(config.gateway.secrets.email).toBe('demo-only-secret-email');
  });

  it('refuses to start in production with a missing or short secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' }, false)).toThrow(/WEBHOOK_SECRET_FORM is required/);
    expect(() => loadConfig({ WEBHOOK_SECRET_FORM: 'short' }, false)).toThrow(/at least 16 characters/);
  });

  it('rejects a rate limit that is not a positive whole number', () => {
    expect(() => loadConfig({ RATE_LIMIT_PER_SEC: '0' }, false)).toThrow(/RATE_LIMIT_PER_SEC/);
    expect(() => loadConfig({ RATE_LIMIT_BURST: '2.5' }, false)).toThrow(/RATE_LIMIT_BURST/);
  });

  it('uses DATABASE_URL when it is set', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://u:p@db.example.test:5432/leads' }, false);
    expect(config.databaseUrl).toBe('postgres://u:p@db.example.test:5432/leads');
  });

  it('treats an empty DATABASE_URL as not set', () => {
    expect(loadConfig({ DATABASE_URL: '' }, false).databaseUrl).toBeUndefined();
  });

  it('rejects a port that is not a number', () => {
    expect(() => loadConfig({ PORT: 'abc' }, false)).toThrow(/PORT must be a port number/);
    expect(() => loadConfig({ EMBEDDED_PG_PORT: '70000' }, false)).toThrow(/EMBEDDED_PG_PORT/);
  });

  it('prints pretty logs in a terminal and JSON otherwise, unless LOG_PRETTY says so', () => {
    expect(loadConfig({}, true).logPretty).toBe(true);
    expect(loadConfig({}, false).logPretty).toBe(false);
    expect(loadConfig({ LOG_PRETTY: '0' }, true).logPretty).toBe(false);
    expect(loadConfig({ LOG_PRETTY: '1' }, false).logPretty).toBe(true);
  });
});
