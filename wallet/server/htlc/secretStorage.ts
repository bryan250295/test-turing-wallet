import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const directory = fileURLToPath(new URL('../../storage/htlc/secrets/', import.meta.url));
const keyPath = join(directory, '.encryption-key');
let keyPromise: Promise<Buffer> | undefined;
let writes: Promise<unknown> = Promise.resolve();
const hex32 = /^[0-9a-f]{64}$/;

function missing(cause: unknown) { return cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT'; }

function getKey(): Promise<Buffer> {
	if (!keyPromise) {
		keyPromise = (async () => {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			let key: Buffer;
			try { key = await readFile(keyPath); }
			catch (cause) {
				if (!missing(cause)) throw cause;
				if ((await readdir(directory)).some((name) => name.endsWith('.json'))) throw new Error('The secret encryption key is missing. Restore it from your storage backup.');
				key = randomBytes(32);
				try { await writeFile(keyPath, key, { flag: 'wx', mode: 0o600 }); }
				catch (error) {
					if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') key = await readFile(keyPath);
					else throw error;
				}
			}
			if (key.length !== 32) throw new Error('The secret encryption key is invalid. Restore your storage backup.');
			return key;
		})();
		keyPromise.catch(() => { keyPromise = undefined; });
	}
	return keyPromise;
}

export async function readSecretRecord(lockTxid: string) {
	if (!hex32.test(lockTxid)) throw new Error('Invalid lock transaction ID.');
	await writes;
	let record;
	try { record = JSON.parse(await readFile(join(directory, `${lockTxid}.json`), 'utf8')); }
	catch (cause) { if (missing(cause)) throw new Error('No saved secret exists for this lock. Older locks still need their original secret.'); throw cause; }
	if (record.version !== 1 || record.network !== 'testnet' || record.lockTxid !== lockTxid || typeof record.owner !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{26,35}$/.test(record.owner) || !hex32.test(record.hashHex) || !/^[0-9a-f]{24}$/.test(record.ivHex) || !/^[0-9a-f]{32}$/.test(record.tagHex) || !hex32.test(record.ciphertextHex)) throw new Error('The saved secret record is invalid.');
	return record as { version: 1; network: 'testnet'; lockTxid: string; owner: string; hashHex: string; ivHex: string; tagHex: string; ciphertextHex: string };
}

const aad = (owner: string, lockTxid: string, hashHex: string) => Buffer.from(JSON.stringify(['htlc-secret-v1', 'testnet', owner, lockTxid, hashHex]));

export function saveClaimSecret(owner: string, lockTxid: string, hashHex: string, secretHex: string) {
	if (!hex32.test(lockTxid) || !hex32.test(hashHex) || !hex32.test(secretHex) || createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest('hex') !== hashHex) throw new Error('The claim secret does not match the reviewed hashlock.');
	const operation = writes.then(async () => {
		const key = await getKey();
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', key, iv);
		cipher.setAAD(aad(owner, lockTxid, hashHex));
		const ciphertext = Buffer.concat([cipher.update(Buffer.from(secretHex, 'hex')), cipher.final()]);
		const record = { version: 1, network: 'testnet', lockTxid, owner, hashHex, ivHex: iv.toString('hex'), tagHex: cipher.getAuthTag().toString('hex'), ciphertextHex: ciphertext.toString('hex') };
		const temporary = join(directory, `${lockTxid}.${randomUUID()}.tmp`);
		await writeFile(temporary, JSON.stringify(record, null, '\t') + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
		await rename(temporary, join(directory, `${lockTxid}.json`));
	});
	writes = operation.catch(() => undefined);
	return operation;
}

export async function decryptClaimSecret(lockTxid: string, owner: string) {
	const record = await readSecretRecord(lockTxid);
	if (record.owner !== owner) throw new Error('The sender wallet does not match this secret.');
	const decipher = createDecipheriv('aes-256-gcm', await getKey(), Buffer.from(record.ivHex, 'hex'));
	decipher.setAAD(aad(record.owner, lockTxid, record.hashHex));
	decipher.setAuthTag(Buffer.from(record.tagHex, 'hex'));
	const secretHex = Buffer.concat([decipher.update(Buffer.from(record.ciphertextHex, 'hex')), decipher.final()]).toString('hex');
	if (createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest('hex') !== record.hashHex) throw new Error('The saved secret does not match its hashlock.');
	return { secretHex, hashHex: record.hashHex, lockTxid };
}
