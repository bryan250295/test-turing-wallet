import 'dotenv/config';
import { databaseAdapter } from '../src/database/adapter';
import { PrismaClient } from '../generated/prisma/client';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { environment } from '../src/config/environment';
import { parseHtlcRequest, type HtlcRequest } from '../../shared/src/utils/htlcRequestHistory';
import { writeRequest } from '../src/htlc/htlc.repository';
import { decryptRecord, parseSecretRecord, type SecretRecord } from '../src/htlc/secrets.repository';

async function entries(directory: string) {
	try { return (await readdir(directory)).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).sort(); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function main() {
	const config = environment();
	const key = await readFile(config.keyFile);
	if (key.length !== 32) throw new Error('Restore the original 32-byte encryption key before importing.');
	const keyId = createHash('sha256').update(key).digest('hex');
	const requests: { path: string; sha256: string; record: HtlcRequest }[] = [];
	const secrets: { path: string; sha256: string; record: SecretRecord }[] = [];
	for (const name of await entries(join(config.legacyDirectory, 'testnet'))) {
		const raw = await readFile(join(config.legacyDirectory, 'testnet', name));
		const value = JSON.parse(raw.toString());
		if (value.network !== 'testnet' || value.schemaVersion !== 1 || value.lockTxid !== name.slice(0, 64)) throw new Error(`Invalid legacy request: ${name}`);
		requests.push({ path: `testnet/${name}`, sha256: createHash('sha256').update(raw).digest('hex'), record: parseHtlcRequest(value) });
	}
	for (const name of await entries(join(config.legacyDirectory, 'secrets'))) {
		const raw = await readFile(join(config.legacyDirectory, 'secrets', name));
		const record = parseSecretRecord(JSON.parse(raw.toString()));
		if (record.lockTxid !== name.slice(0, 64)) throw new Error(`Secret filename mismatch: ${name}`);
		// Authenticate every encrypted record using the original AAD and key. Never print plaintext.
		decryptRecord(record, key);
		secrets.push({ path: `secrets/${name}`, sha256: createHash('sha256').update(raw).digest('hex'), record });
	}
	const db = new PrismaClient({ adapter: databaseAdapter() });
	try {
		const result = await db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('legacy-storage-import-v1', 0))`;
			let importedRequests = 0, importedSecrets = 0;
			for (const item of [...requests, ...secrets]) {
				const previous = await tx.storageImport.findUnique({ where: { path: item.path } });
				if (previous && previous.sha256 !== item.sha256) throw new Error(`Previously imported source changed: ${item.path}. Resolve it explicitly before starting.`);
			}
			for (const item of requests) {
				if (await tx.storageImport.findUnique({ where: { path: item.path } })) continue;
				const existing = await tx.htlcRequest.findUnique({ where: { network_lockTxid: { network: 'testnet', lockTxid: item.record.lockTxid } } });
				if (existing) throw new Error(`An untracked database record conflicts with ${item.path}. No records were imported.`);
				await writeRequest(tx, item.record, 'legacy_import', true);
				await tx.storageImport.create({ data: { path: item.path, sha256: item.sha256 } });
				importedRequests++;
			}
			for (const item of secrets) {
				if (await tx.storageImport.findUnique({ where: { path: item.path } })) continue;
				const id = { network: 'testnet', lockTxid: item.record.lockTxid };
				const existing = await tx.claimSecret.findUnique({ where: { network_lockTxid: id } });
				if (existing) throw new Error(`An untracked encrypted record conflicts with ${item.path}. No records were imported.`);
				await tx.claimSecret.create({ data: { ...item.record, keyId } });
				await tx.storageImport.create({ data: { path: item.path, sha256: item.sha256 } });
				importedSecrets++;
			}
			return { importedRequests, importedSecrets, sourceRequests: requests.length, sourceSecrets: secrets.length };
		}, { timeout: 120000, maxWait: 15000 });
		console.log(JSON.stringify({ event: 'storage-import-completed', ...result }));
	} finally { await db.$disconnect(); key.fill(0); }
}
void main().catch((error: unknown) => { console.error(error instanceof Error && !error.name.startsWith('Prisma') ? error.message : 'Storage import failed. The transaction was rolled back; check database availability.'); process.exitCode = 1; });
