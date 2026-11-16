import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/database.ts';
import { migrate } from './db/migrate.ts';
import { loadDotEnv } from './env.ts';
import { AnthropicClassifier, RecordedClassifier } from './ai/classifier.ts';
import { loadPriceList } from './ai/pricing.ts';
import { HttpCrmClient } from './crm/http-crm.ts';
import { createDelivery } from './delivery/deliver-job.ts';
import { CLASSIFY_JOB, makeClassifyHandler } from './leads/classify-job.ts';
import { processLead } from './leads/process.ts';
import { createLogger } from './logger.ts';
import { startWorker, WORKER_ID } from './queue/worker.ts';

loadDotEnv();
const config = loadConfig();
const log = createLogger(config);

const db = await openDatabase(config, log);
const applied = await migrate(db.pool);
log.info({ applied }, applied.length ? 'database migrations applied' : 'database is up to date');

if (config.gateway.usingDemoSecrets) {
  log.warn('using the built-in DEMO webhook secrets; set WEBHOOK_SECRET_<SOURCE> before real use');
}
if (config.admin.usingDemoToken) {
  log.warn('using the built-in DEMO admin token for /dead-letter and /replay; set ADMIN_TOKEN before real use');
}
// ROLE=worker: an extra worker process, sharing the queue, with no HTTP port.
const app = config.role === 'all' ? buildApp({ pool: db.pool, log, gateway: config.gateway, admin: config.admin }) : undefined;
await app?.listen({ port: config.port, host: config.host });
const classifier = config.ai.mode === 'live' ? new AnthropicClassifier(config.ai.model) : new RecordedClassifier();
log.info(
  { ai_mode: classifier.mode, model: classifier.model },
  classifier.mode === 'live' ? 'AI: calling the Anthropic API (costs money)' : 'AI: replaying recorded answers (no key, no cost); set AI_MODE=live to call the API',
);
const classify = makeClassifyHandler({ classifier, prices: loadPriceList(), minConfidence: config.ai.minConfidence });
const workers = [
  startWorker({ pool: db.pool, log, kind: 'process', handler: processLead, concurrency: config.workerConcurrency }),
  startWorker({ pool: db.pool, log, kind: CLASSIFY_JOB, handler: classify, concurrency: config.workerConcurrency }),
  startWorker(createDelivery({ pool: db.pool, log, crm: new HttpCrmClient({ baseUrl: config.crm.url, timeoutMs: config.crm.timeoutMs }), ...config.crm })),
];
log.info(
  { crm: config.crm.url, max_attempts: config.crm.maxAttempts, rate_limit_per_sec: config.crm.rateLimitPerSec, breaker_threshold: config.crm.breakerThreshold },
  `CRM deliveries go to ${config.crm.url} (start the fake one with: npm run crm)`,
);
if (app) log.info(`ready: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/ready`);
else log.info(`ready: worker-only process ${WORKER_ID}, no HTTP port`);

// Stop taking requests and let the ones in flight finish; let the workers finish
// the jobs they hold; then close the connection pool; Postgres goes last.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  try {
    await app?.close();
    await Promise.all(workers.map((w) => w.stop()));
    await db.close();
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
