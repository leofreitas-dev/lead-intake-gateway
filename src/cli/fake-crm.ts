// npm run crm -- [--mode ok|down|429|500|slow] [--port 4010] [--rate 10] [--slow-ms 5000] [--reset]
// Runs the fake CRM as its own process. Change its mode while it runs with
// `npm run crm:mode -- <mode>`. It keeps everything it received in data/fake-crm/.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { loadDotEnv } from '../env.ts';
import { buildFakeCrm, isMode, MODE_HELP, MODES, summary } from '../fake-crm/server.ts';
import { createLogger } from '../logger.ts';

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'ok' },
    port: { type: 'string' },
    rate: { type: 'string', default: '10' },
    'slow-ms': { type: 'string', default: '5000' },
    reset: { type: 'boolean', default: false },
  },
});
loadDotEnv();
const config = loadConfig();
const log = createLogger({ ...config, logLevel: 'info' });
if (!isMode(values.mode)) {
  console.error(`--mode must be one of: ${MODES.join(', ')}`);
  process.exit(1);
}
const port = Number(values.port ?? new URL(config.crm.url).port);
const storeFile = path.join(config.dataDir, 'fake-crm', 'store.json');
if (values.reset) fs.rmSync(storeFile, { force: true });

const crm = buildFakeCrm({ mode: values.mode, rateLimitPerSec: Number(values.rate), slowMs: Number(values['slow-ms']), storeFile, log });
await crm.listen({ port, host: '127.0.0.1' });
const s = summary(crm.state);
log.info(
  { mode: values.mode, store: path.relative(process.cwd(), storeFile), contacts: s.activeContacts, calls: s.calls },
  `fake CRM listening on http://127.0.0.1:${port} in mode "${values.mode}": ${MODE_HELP[values.mode]}`,
);
log.info(`change the mode with: npm run crm:mode -- <${MODES.join('|')}>`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await crm.close();
  log.info('fake CRM stopped');
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
