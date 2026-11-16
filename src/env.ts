import { existsSync } from 'node:fs';

/** Loads `.env` into process.env when the file exists. Real env vars win. */
export function loadDotEnv(file = '.env'): void {
  if (existsSync(file)) process.loadEnvFile(file);
}
