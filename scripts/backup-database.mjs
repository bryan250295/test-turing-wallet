import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function main() {
  const config = await readFile(resolve(root, '.env'), 'utf8');
  const values = Object.fromEntries(config.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  for (const key of ['POSTGRES_USER', 'POSTGRES_DB']) if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(values[key] ?? '')) throw new Error(`Invalid ${key}.`);
  const directory = resolve(root, '.backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `postgres-${new Date().toISOString().replaceAll(':', '-')}.dump`);
  const production = process.argv.includes('--production');
  const args = ['compose', ...(production ? ['-f', 'compose.production.yaml'] : []), 'exec', '-T', 'postgres', 'pg_dump', '-U', values.POSTGRES_USER, '-d', values.POSTGRES_DB, '-Fc'];
  const child = spawn('docker', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  // Keep stderr private; report only process status to avoid leaking connection configuration.
  child.stderr.resume();
  const ended = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', (code) => code === 0 ? resolveExit() : reject(new Error('pg_dump failed; the output must not be used as a backup.'))); });
  await Promise.all([pipeline(child.stdout, createWriteStream(path, { flags: 'wx', mode: 0o600 })), ended]);
  await chmod(path, 0o600);
  console.log(`Database backup saved: ${path}`);
  console.log('Back up .secrets/htlc.key and .secrets/bridge-custody.key separately. A database dump alone cannot recover encrypted secrets or custody keys.');
}
void main().catch((error) => { console.error(error.message); process.exitCode = 1; });
