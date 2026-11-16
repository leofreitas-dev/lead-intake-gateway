// npm run n8n [-- <n8n command>]   (or n8n/run-local.sh)
//
// A local n8n to try the workflows in n8n/: the n8n installed in tools/n8n,
// on a Postgres of its own (embedded, in .n8n-local/pg, port 25440; never the
// gateway's database), listening on 127.0.0.1 only, with no telemetry.
// Postgres starts before n8n and stops after it, also on Ctrl+C.
//
//   npm run n8n                                   start n8n on http://127.0.0.1:5678
//   npm run n8n -- import:workflow --input=n8n/lead-form-to-gateway.json
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startEmbeddedPostgres } from '../db/embedded.ts';
import { createLogger } from '../logger.ts';

const N8N_BIN = path.resolve('tools/n8n/node_modules/n8n/bin/n8n');
const USER_FOLDER = path.resolve('.n8n-local');
const PG_PORT = Number(process.env.N8N_PG_PORT || 25440);

if (!fs.existsSync(N8N_BIN)) {
  console.error('n8n is not installed in tools/n8n. See n8n/README.md.');
  process.exit(1);
}

const log = createLogger({ logLevel: 'warn', logPretty: true });
const pg = await startEmbeddedPostgres({ dir: path.join(USER_FOLDER, 'pg'), port: PG_PORT, database: 'n8n', log });
const db = new URL(pg.url);

const args = process.argv.slice(2);
const child = spawn(process.execPath, [N8N_BIN, ...(args.length ? args : ['start'])], {
  stdio: 'inherit',
  env: {
    ...process.env,
    N8N_USER_FOLDER: USER_FOLDER,
    N8N_PORT: process.env.N8N_PORT || '5678',
    N8N_LISTEN_ADDRESS: '127.0.0.1',
    N8N_HOST: '127.0.0.1',
    N8N_DIAGNOSTICS_ENABLED: 'false',
    N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    N8N_PERSONALIZATION_ENABLED: 'false',
    N8N_TEMPLATES_ENABLED: 'false',
    DB_TYPE: 'postgresdb',
    DB_POSTGRESDB_HOST: db.hostname,
    DB_POSTGRESDB_PORT: db.port,
    DB_POSTGRESDB_DATABASE: db.pathname.slice(1),
    DB_POSTGRESDB_USER: decodeURIComponent(db.username),
    DB_POSTGRESDB_PASSWORD: decodeURIComponent(db.password),
  },
});

// Ctrl+C reaches n8n through the terminal; a plain kill of this process is passed on.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));

const code = await new Promise<number>((resolve) => child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0))));
await pg.stop();
process.exit(code);
