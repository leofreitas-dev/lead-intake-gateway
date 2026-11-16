// npm run crm:mode -- <ok|down|429|500|slow>   changes the mode of the running fake CRM
// npm run crm:mode                            shows its mode and what it holds
import { loadConfig } from '../config.ts';
import { loadDotEnv } from '../env.ts';
import { MODE_HELP, MODES, type Mode } from '../fake-crm/server.ts';

loadDotEnv();
const base = loadConfig().crm.url.replace(/\/$/, '');
const [mode] = process.argv.slice(2);

try {
  if (mode) {
    const res = await fetch(`${base}/_admin/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok) {
      console.error(`Unknown mode "${mode}". Use one of: ${MODES.join(', ')}.`);
      process.exit(1);
    }
    console.log(`fake CRM is now "${mode}": ${MODE_HELP[mode as Mode]}`);
  }
  const state = (await (await fetch(`${base}/_admin/state`)).json()) as {
    mode: Mode; calls: number; callsByStatus: Record<string, number>; contactRecords: number; activeContacts: number;
  };
  if (!mode) console.log(`fake CRM mode: "${state.mode}" (${MODE_HELP[state.mode]})`);
  console.log(`contacts in the CRM: ${state.activeContacts} (records: ${state.contactRecords}, merged ones included)`);
  console.log(`calls received: ${state.calls}  ${JSON.stringify(state.callsByStatus)}`);
} catch {
  console.error(`The fake CRM is not answering at ${base}. Start it with: npm run crm`);
  process.exit(1);
}
