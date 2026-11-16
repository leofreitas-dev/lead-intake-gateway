import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  it('runs with no settings at all: local-only, embedded Postgres', () => {
    const config = loadConfig({}, false);
    expect(config).toEqual({
      port: 3000,
      host: '127.0.0.1',
      databaseUrl: undefined,
      dataDir: path.resolve('data'),
      embeddedPgPort: 54329,
      logLevel: 'info',
      logPretty: false,
    });
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
