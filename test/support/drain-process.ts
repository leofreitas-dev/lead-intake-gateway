// A separate OS process that works the "process" queue of a test database,
// like a second gateway instance would. Used by the identity stress test.
// Usage: node test/support/drain-process.ts <database-url> <concurrency> [start-gate-key]
// With a start-gate key, it waits until the test releases that advisory lock,
// so every process starts at the same moment. Prints its outcome counts as JSON.
import { createPool } from '../../src/db/database.ts';
import { processLead } from '../../src/leads/process.ts';
import { createLogger } from '../../src/logger.ts';
import { drain } from '../../src/queue/worker.ts';

const [url, concurrency = '4', gateKey] = process.argv.slice(2);
const log = createLogger({ logLevel: 'silent', logPretty: false });
const pool = createPool(url, log);
if (gateKey) {
  const client = await pool.connect();
  await client.query('select pg_advisory_lock_shared($1)', [gateKey]);
  await client.query('select pg_advisory_unlock_shared($1)', [gateKey]);
  client.release();
}
const counts = await drain({ pool, log, kind: 'process', handler: processLead, concurrency: Number(concurrency), backoff: () => 20 });
await pool.end();
console.log(JSON.stringify(counts));
