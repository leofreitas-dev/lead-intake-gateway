// npm run send -- <source> <fixture> [options]
// Signs a fixture with the channel's secret and posts it to the running gateway.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { loadDotEnv } from '../env.ts';
import { signatureHeader } from '../gateway/signature.ts';
import { isSource, SOURCES } from '../sources.ts';

const USAGE = `Usage: npm run send -- <source> <fixture> [options]

  <source>   ${SOURCES.join(' | ')}
  <fixture>  file name in fixtures/webhooks/<source>/ (without extension), e.g. lead-01

Options:
  --times <n>        send the same webhook n times (default 1)
  --parallel         send the n copies at the same moment instead of one after another
  --event-id <id>    add an X-Event-Id header, like a provider would
  --bad-signature    sign with the wrong secret (expect 401)
  --stale            sign as if 10 minutes ago (expect 401)
  --url <url>        gateway address (default http://127.0.0.1:$PORT)

Example: npm run send -- form lead-01 --times 3`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    times: { type: 'string', default: '1' },
    parallel: { type: 'boolean', default: false },
    'event-id': { type: 'string' },
    'bad-signature': { type: 'boolean', default: false },
    stale: { type: 'boolean', default: false },
    url: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [source, fixture] = positionals;
if (values.help || !source || !fixture) exit(USAGE, values.help ? 0 : 1);
if (!isSource(source)) exit(`Unknown source "${source}". Use one of: ${SOURCES.join(', ')}.`);
const times = Number(values.times);
if (!Number.isInteger(times) || times < 1 || times > 1000) exit('--times must be a whole number from 1 to 1000.');

const dir = path.join('fixtures', 'webhooks', source);
const file = ['.json', '.txt'].map((ext) => path.join(dir, fixture + ext)).find((f) => existsSync(f));
if (!file) exit(`No fixture "${fixture}" in ${dir}/.`);
// JSON fixtures are sent compact, like a provider would; .txt files are sent as they are.
const raw = readFileSync(file, 'utf8');
const body = file.endsWith('.json') ? JSON.stringify(JSON.parse(raw)) : raw.trimEnd();

loadDotEnv();
const config = loadConfig();
const url = `${values.url ?? `http://127.0.0.1:${config.port}`}/webhooks/${source}`;
const secret = values['bad-signature'] ? 'definitely-not-the-right-secret' : config.gateway.secrets[source];
const signedAt = Math.floor(Date.now() / 1000) - (values.stale ? 600 : 0);

const headers: Record<string, string> = {
  'content-type': 'application/json',
  'x-signature': signatureHeader(secret, body, signedAt),
};
if (values['event-id']) headers['x-event-id'] = values['event-id'];

console.log(`POST ${url}  (${file}, ${times}x${values.parallel ? ' at once' : ''})`);

async function sendOnce(n: number): Promise<void> {
  try {
    const res = await fetch(url, { method: 'POST', headers, body });
    const retry = res.headers.get('retry-after');
    console.log(`#${n}  ${res.status}  ${await res.text()}${retry ? `  (retry after ${retry}s)` : ''}`);
  } catch (err) {
    console.log(`#${n}  no answer: ${(err as Error).cause ?? (err as Error).message}. Is the gateway running (npm run dev)?`);
    process.exitCode = 1;
  }
}

const runs = Array.from({ length: times }, (_, i) => i + 1);
if (values.parallel) await Promise.all(runs.map(sendOnce));
else for (const n of runs) await sendOnce(n);

function exit(message: string, code = 1): never {
  (code === 0 ? console.log : console.error)(message);
  process.exit(code);
}
