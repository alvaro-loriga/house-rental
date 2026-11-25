// Starts a throwaway real PostgreSQL server for local development and database tests.
// Binaries come from the `embedded-postgres` npm package. They are copied to a short
// temp path first because Windows refuses to run them from very deep directories.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

function platformPackage() {
  const map = {
    'win32-x64': 'windows-x64',
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
    'darwin-x64': 'darwin-x64',
    'darwin-arm64': 'darwin-arm64',
  };
  const key = `${process.platform}-${process.arch}`;
  if (!map[key]) throw new Error(`No embedded PostgreSQL binaries for ${key}`);
  return `@embedded-postgres/${map[key]}`;
}

function binaries() {
  const pkg = platformPackage();
  // The package does not export package.json, so walk up from its entry point.
  let dir = path.dirname(require.resolve(pkg));
  while (!fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
  const pkgJson = path.join(dir, 'package.json');
  const version = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version;
  const source = path.join(path.dirname(pkgJson), 'native');
  if (process.platform !== 'win32') return source;
  const target = path.join(os.tmpdir(), `rental-pg-${version}`);
  if (!fs.existsSync(path.join(target, '.complete'))) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true });
    fs.writeFileSync(path.join(target, '.complete'), '');
  }
  return target;
}

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

/**
 * @param {{ port?: number, dataDir?: string }} [options] dataDir makes the cluster persistent.
 * @returns {Promise<{ connectionString: string, port: number, stop: () => Promise<void> }>}
 */
export async function startPostgres(options = {}) {
  const port = options.port ?? 54329;
  const native = binaries();
  const persistent = Boolean(options.dataDir);
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'rental-pgdata-'));
  const env = { ...process.env, TZ: 'UTC', PGTZ: 'UTC' };

  // If an earlier run on this port was killed without a clean shutdown (common on Windows),
  // stop its orphaned server and remove its throwaway data directory first.
  const stateFile = path.join(os.tmpdir(), `rental-pg-port-${port}.json`);
  try {
    const previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (previous.dataDir && fs.existsSync(previous.dataDir)) {
      spawnSync(path.join(native, 'bin', exe('pg_ctl')), ['stop', '-D', previous.dataDir, '-m', 'immediate', '-w'], { env });
      if (previous.temporary) fs.rmSync(previous.dataDir, { recursive: true, force: true });
    }
  } catch {
    // no previous run
  }
  fs.writeFileSync(stateFile, JSON.stringify({ dataDir, temporary: !persistent }));

  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    fs.mkdirSync(dataDir, { recursive: true });
    const pwFile = path.join(os.tmpdir(), `rental-pgpw-${process.pid}-${port}`);
    fs.writeFileSync(pwFile, 'postgres');
    const init = spawnSync(
      path.join(native, 'bin', exe('initdb')),
      ['-D', dataDir, '-U', 'postgres', '-A', 'scram-sha-256', `--pwfile=${pwFile}`, '-E', 'UTF8', '--locale=C'],
      { env, encoding: 'utf8' },
    );
    fs.rmSync(pwFile, { force: true });
    if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr || init.stdout}`);
  }

  const server = spawn(
    path.join(native, 'bin', exe('postgres')),
    ['-D', dataDir, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', 'timezone=UTC', '-c', 'max_connections=60', '-c', 'fsync=off'],
    { env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PostgreSQL did not start:\n${log}`)), 60000);
    server.stderr.on('data', (chunk) => {
      log += chunk.toString();
      if (/database system is ready to accept connections/.test(log)) {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
    server.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`PostgreSQL exited with code ${code}:\n${log}`));
    });
  });

  return {
    port,
    connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    stop: () =>
      new Promise((resolve) => {
        server.removeAllListeners('exit');
        server.on('exit', () => {
          if (!persistent) fs.rmSync(dataDir, { recursive: true, force: true });
          fs.rmSync(stateFile, { force: true });
          resolve();
        });
        if (process.platform === 'win32') {
          spawnSync(path.join(native, 'bin', exe('pg_ctl')), ['stop', '-D', dataDir, '-m', 'fast'], { env });
        } else {
          server.kill('SIGINT');
        }
      }),
  };
}
