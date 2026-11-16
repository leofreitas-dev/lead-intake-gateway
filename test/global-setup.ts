// Gives the tests a Postgres server: DATABASE_URL when set (CI), otherwise a
// throwaway embedded Postgres in a temp folder that is deleted afterwards.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { startEmbeddedPostgres, type EmbeddedServer } from '../src/db/embedded.ts';
import { createLogger } from '../src/logger.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}

export const TEST_PG_PORT = 25434;

let server: EmbeddedServer | undefined;
let tempDir: string | undefined;

export async function setup(project: TestProject) {
  if (process.env.DATABASE_URL) {
    project.provide('adminDatabaseUrl', process.env.DATABASE_URL);
    return;
  }
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lead-intake-test-'));
  server = await startEmbeddedPostgres({
    dir: path.join(tempDir, 'pg'),
    port: TEST_PG_PORT,
    database: 'postgres',
    log: createLogger({ logLevel: 'warn', logPretty: false }),
  });
  project.provide('adminDatabaseUrl', server.url);
}

export async function teardown() {
  await server?.stop();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
}
