import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/database.ts';
import { migrate } from './db/migrate.ts';
import { loadDotEnv } from './env.ts';
import { createLogger } from './logger.ts';

loadDotEnv();
const config = loadConfig();
const log = createLogger(config);

const db = await openDatabase(config, log);
const applied = await migrate(db.pool);
log.info({ applied }, applied.length ? 'database migrations applied' : 'database is up to date');

if (config.gateway.usingDemoSecrets) {
  log.warn('using the built-in DEMO webhook secrets; set WEBHOOK_SECRET_<SOURCE> before real use');
}
const app = buildApp({ pool: db.pool, log, gateway: config.gateway });
await app.listen({ port: config.port, host: config.host });
log.info(`ready: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/ready`);

// Stop taking requests, let the ones in flight finish, then close the database.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await db.close();
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
