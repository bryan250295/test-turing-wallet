import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function readIfPresent(path) { try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function main() {
  const source = resolve(root, 'wallet/storage/htlc');
  const keyDirectory = resolve(root, '.secrets');
  await mkdir(keyDirectory, { recursive: true, mode: 0o700 });
  const legacyKey = await readIfPresent(resolve(source, 'secrets/.encryption-key'));
  let key = await readIfPresent(resolve(keyDirectory, 'htlc.key'));
  let encryptedFiles = [];
  try { encryptedFiles = (await readdir(resolve(source, 'secrets'))).filter((name) => name.endsWith('.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (encryptedFiles.length && !legacyKey && !key) throw new Error('Restore the original encryption key before setup.');
  if (legacyKey && legacyKey.length !== 32 || key && key.length !== 32) throw new Error('Invalid encryption key length.');
  if (legacyKey && key && !timingSafeEqual(legacyKey, key)) throw new Error('Existing and legacy encryption keys differ. Resolve this before starting.');
  if (!key) {
    key = legacyKey ?? randomBytes(32);
    await writeFile(resolve(keyDirectory, 'htlc.key'), key, { flag: 'wx', mode: 0o600 });
  }
  // Docker's non-root node user must be able to read the local Compose file secret.
  // The parent directory is accessible only to this host user; the key is never baked into an image.
  await chmod(resolve(keyDirectory, 'htlc.key'), 0o644);
  // Independent custody encryption key; never repurpose the existing HTLC key.
  // Restore an existing backup if present, and never overwrite either key.
  const custodyPath = resolve(keyDirectory, 'bridge-custody.key');
  const custodyBackupDirectory = resolve(root, '.backups');
  await mkdir(custodyBackupDirectory, { recursive: true, mode: 0o700 });
  const custodyBackupPath = resolve(custodyBackupDirectory, 'bridge-custody.key');
  let custodyKey = await readIfPresent(custodyPath);
  const custodyBackup = await readIfPresent(custodyBackupPath);
  if (custodyKey && custodyKey.length !== 32 || custodyBackup && custodyBackup.length !== 32) throw new Error('Invalid custody key length. Restore the correct custody key.');
  if (custodyKey && custodyBackup && !timingSafeEqual(custodyKey, custodyBackup)) throw new Error('The custody key and its backup differ. Existing keys were retained.');
  if (!custodyKey) {
    custodyKey = custodyBackup ?? randomBytes(32);
    await writeFile(custodyPath, custodyKey, { flag: 'wx', mode: 0o600 });
  }
  // As for htlc.key, the 0700 parent protects host access while the non-root
  // container reads the explicitly mounted, read-only Compose file secret.
  await chmod(custodyPath, 0o644);
  if (!custodyBackup) await writeFile(custodyBackupPath, custodyKey, { flag: 'wx', mode: 0o600 });
  custodyKey.fill(0);
  const envPath = resolve(root, '.env');
  let local = await readIfPresent(envPath);
  if (!local) {
    local = Buffer.from(`POSTGRES_USER=learning_bridge\nPOSTGRES_DB=learning_bridge\nPOSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\nPOSTGRES_PORT=5433\nFRONTEND_PORT=5173\nAPP_ORIGIN=http://localhost:5173\nSESSION_HOURS=12\n`);
    await writeFile(envPath, local, { mode: 0o600, flag: 'wx' });
  }
  const values = Object.fromEntries(local.toString().split('\n').filter((line) => line && !line.startsWith('#')).map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (!/^[0-9a-f]{64}$/.test(values.POSTGRES_PASSWORD ?? '')) throw new Error('Expected a generated 64-character hexadecimal POSTGRES_PASSWORD. Existing configuration was retained.');
  if (!values.APP_DB_USER || !values.APP_DB_PASSWORD) {
    values.APP_DB_USER = 'learning_bridge_app';
    values.APP_DB_PASSWORD = randomBytes(32).toString('hex');
    await writeFile(envPath, local.toString().trimEnd() + `\nAPP_DB_USER=${values.APP_DB_USER}\nAPP_DB_PASSWORD=${values.APP_DB_PASSWORD}\n`, { mode: 0o600 });
  }
  const backendEnv = resolve(root, 'backend/.env');
  const existingBackend = await readIfPresent(backendEnv);
  if (existingBackend) {
    const oldUrl = `postgresql://${values.POSTGRES_USER}:${values.POSTGRES_PASSWORD}@127.0.0.1:${values.POSTGRES_PORT}/${values.POSTGRES_DB}?schema=public`;
    const appUrl = `postgresql://${values.APP_DB_USER}:${values.APP_DB_PASSWORD}@127.0.0.1:${values.POSTGRES_PORT}/${values.POSTGRES_DB}?schema=public`;
    await writeFile(backendEnv, existingBackend.toString().replace(oldUrl, appUrl), { mode: 0o600 });
  }
  if (!await readIfPresent(backendEnv)) await writeFile(backendEnv, `DATABASE_URL=postgresql://${values.APP_DB_USER}:${values.APP_DB_PASSWORD}@127.0.0.1:${values.POSTGRES_PORT}/${values.POSTGRES_DB}?schema=public\nAPP_ORIGIN=${values.APP_ORIGIN}\nPORT=3001\nSESSION_HOURS=${values.SESSION_HOURS ?? '12'}\nSECRET_KEY_FILE=../.secrets/htlc.key\nBRIDGE_CUSTODY_KEY_FILE=../.secrets/bridge-custody.key\nLEGACY_STORAGE_DIR=../wallet/storage/htlc\n`, { mode: 0o600, flag: 'wx' });
  const backupRoot = resolve(root, '.backups');
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const marker = resolve(backupRoot, '.initial-storage-backup');
  if (!await readIfPresent(marker)) {
    const destination = resolve(backupRoot, `legacy-${new Date().toISOString().replaceAll(':', '-')}`);
    await mkdir(destination, { mode: 0o700 });
    try { await cp(source, resolve(destination, 'htlc'), { recursive: true, force: false, errorOnExist: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await cp(resolve(keyDirectory, 'htlc.key'), resolve(destination, 'htlc.key'));
    await chmod(resolve(destination, 'htlc.key'), 0o600);
    await writeFile(marker, `${destination}\n`, { mode: 0o600, flag: 'wx' });
  }
  await mkdir(resolve(source, 'testnet'), { recursive: true });
  await mkdir(resolve(source, 'secrets'), { recursive: true });
  console.log('Local configuration, independent HTLC/custody encryption keys and backups are ready. No secret values were printed.');
}
void main().catch((error) => { console.error(error.message); process.exitCode = 1; });
