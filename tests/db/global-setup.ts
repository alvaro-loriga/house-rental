import type { TestProject } from 'vitest/node';
import { startPostgres } from '../../scripts/pg-runtime.mjs';
import { applyMigrations } from '../../scripts/db-setup.mjs';

export default async function setup(project: TestProject) {
  const server = await startPostgres({ port: 54331 });
  await applyMigrations(server.connectionString);
  project.provide('databaseUrl', server.connectionString);
  return async () => {
    await server.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
