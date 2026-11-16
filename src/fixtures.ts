import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Source } from './sources.ts';

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

/**
 * The exact body a channel would send for `fixtures/webhooks/<source>/<name>`.
 * A .json fixture is sent compact, like a provider would; a .txt fixture is a
 * deliberately broken body and is sent as it is.
 */
export function loadFixture(source: Source, name: string): { file: string; body: string } {
  const dir = path.join(FIXTURES_DIR, 'webhooks', source);
  const file = ['.json', '.txt'].map((ext) => path.join(dir, name + ext)).find((f) => existsSync(f));
  if (!file) throw new Error(`No fixture "${name}" in fixtures/webhooks/${source}/.`);
  const raw = readFileSync(file, 'utf8');
  return { file: path.relative(process.cwd(), file), body: file.endsWith('.json') ? JSON.stringify(JSON.parse(raw)) : raw.trimEnd() };
}

/** The demo's webhooks, in the order they arrive. */
export function demoScript(): { source: Source; fixture: string; note: string }[] {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'demo.json'), 'utf8'));
}
