// Applies the Supabase shim and every migration (in file-name order) to a database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function migrationFiles() {
  const dir = path.join(root, 'supabase', 'migrations');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(dir, f));
}

export async function runSqlFile(connectionString, file) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    error.message = `${path.basename(file)}: ${error.message}`;
    throw error;
  } finally {
    await client.end();
  }
}

export async function applyMigrations(connectionString) {
  await runSqlFile(connectionString, path.join(root, 'tests', 'db', 'supabase-shim.sql'));
  for (const file of migrationFiles()) await runSqlFile(connectionString, file);
}
