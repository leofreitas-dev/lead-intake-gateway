import path from 'node:path';

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
}

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
  };
}

function toPort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a port number between 1 and 65535, got "${value}"`);
  }
  return port;
}
