// npm run db:migrate: applies pending migrations and exits.
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/database.ts';
import { migrate } from '../db/migrate.ts';
import { loadDotEnv } from '../env.ts';
import { createLogger } from '../logger.ts';

loadDotEnv();
const config = loadConfig();
const log = createLogger(config);
const db = await openDatabase(config, log);
try {
  const applied = await migrate(db.pool);
  log.info({ applied }, applied.length ? `applied ${applied.length} migration(s)` : 'nothing to apply');
} finally {
  await db.close();
}
