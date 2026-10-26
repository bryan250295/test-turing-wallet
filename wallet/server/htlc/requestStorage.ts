import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mergeHtlcRequest, parseHtlcRequest } from '../../src/utils/htlcRequestHistory';
import type { HtlcRequest } from '../../src/utils/htlcRequestHistory';

const directory = fileURLToPath(new URL('../../storage/htlc/testnet/', import.meta.url));
let writes: Promise<unknown> = Promise.resolve();

function missing(cause: unknown) {
	return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

async function readRequest(path: string) {
	try { return parseHtlcRequest(JSON.parse(await readFile(path, 'utf8'))); }
	catch (cause) { if (missing(cause)) return undefined; throw cause; }
}

export function saveStoredHtlcRequest(value: unknown): Promise<HtlcRequest> {
	const next = parseHtlcRequest(value);
	const operation = writes.then(async () => {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, `${next.lockTxid}.json`);
		const request = { ...mergeHtlcRequest(await readRequest(path), next), updatedAt: new Date().toISOString() };
		const temporary = join(directory, `${next.lockTxid}.${randomUUID()}.tmp`);
		await writeFile(temporary, JSON.stringify({ schemaVersion: 1, network: 'testnet', ...request }, null, '\t') + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
		await rename(temporary, path);
		return request;
	});
	writes = operation.catch(() => undefined);
	return operation;
}

export async function listStoredHtlcRequests(address: string) {
	await writes;
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const requests: HtlcRequest[] = [];
	for (const name of await readdir(directory)) {
		if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
		const request = await readRequest(join(directory, name));
		if (request && (request.sender === address || request.receiver === address)) requests.push(request);
	}
	return requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getStoredHtlcRequest(lockTxid: string) {
	if (!/^[0-9a-f]{64}$/.test(lockTxid)) throw new Error('Invalid lock transaction ID.');
	await writes;
	return readRequest(join(directory, `${lockTxid}.json`));
}
