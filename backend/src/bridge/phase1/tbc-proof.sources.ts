import type { TbcBlockRecord, TbcNetwork, TbcProofDataSource, TbcTransactionLocation } from './tbc-proof.types';
import { normalizeHash } from './tbc-proof.crypto';

type JsonRecord = Record<string, unknown>;

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_TRANSACTIONS = 100_000;

function record(value: unknown, label: string): JsonRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is not an object.`);
	return value as JsonRecord;
}

function unwrap(value: unknown): unknown {
	let current = value;
	for (let depth = 0; depth < 2; depth++) {
		if (!current || typeof current !== 'object' || Array.isArray(current)) break;
		const object = current as JsonRecord;
		if (!('data' in object)) break;
		current = object.data;
	}
	return current;
}

function field(object: JsonRecord, names: readonly string[]) {
	for (const name of names) if (object[name] !== undefined && object[name] !== null) return object[name];
	return undefined;
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER) {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`${label} is not a supported unsigned integer.`);
	return parsed;
}

function optionalInteger(value: unknown, label: string) {
	return value === undefined || value === null ? null : integer(value, label);
}

function uint32(value: unknown, label: string) {
	if (typeof value === 'string' && /^(?:0x)?[0-9a-f]{1,8}$/i.test(value) && (value.startsWith('0x') || /[a-f]/i.test(value))) {
		return integer(Number.parseInt(value.replace(/^0x/i, ''), 16), label, 0xffffffff);
	}
	return integer(value, label, 0xffffffff);
}

function compactBits(value: unknown) {
	if (typeof value === 'string' && /^(?:0x)?[0-9a-f]{1,8}$/i.test(value)) {
		return integer(Number.parseInt(value.replace(/^0x/i, ''), 16), 'Block bits', 0xffffffff);
	}
	return integer(value, 'Block bits', 0xffffffff);
}

function hashField(object: JsonRecord, names: readonly string[], label: string) {
	const value = field(object, names);
	if (typeof value !== 'string') throw new Error(`${label} is missing.`);
	return normalizeHash(value, label);
}

function rawHex(value: unknown): string | null {
	if (typeof value === 'string' && /^(?:[0-9a-f]{2})+$/i.test(value)) return value.toLowerCase();
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const object = value as JsonRecord;
	for (const name of ['txraw', 'rawtx', 'raw', 'hex']) {
		const candidate = rawHex(object[name]);
		if (candidate) return candidate;
	}
	return object.data === value ? null : rawHex(object.data);
}

function parseBlock(value: unknown): TbcBlockRecord {
	const object = record(unwrap(value), 'Block response');
	const transactions = field(object, ['tx', 'txs', 'transactions']);
	const transactionCountValue = field(object, ['tx_count', 'txCount', 'txcnt', 'nTx', 'transactionCount']);
	const transactionCount = transactionCountValue === undefined && Array.isArray(transactions)
		? transactions.length : integer(transactionCountValue, 'Block transaction count', MAX_TRANSACTIONS);
	return {
		hash: hashField(object, ['id', 'hash', 'blockhash', 'block_hash'], 'Block hash'),
		height: integer(field(object, ['height', 'blockheight', 'block_height']), 'Block height'),
		version: uint32(field(object, ['version']), 'Block version'),
		previousBlockHash: hashField(object, ['previousblockhash', 'previoushash', 'previousBlockHash', 'previous_block_hash', 'previous_hash', 'prev_hash'], 'Previous block hash'),
		merkleRoot: hashField(object, ['merkleroot', 'merkleRoot', 'merkle_root'], 'Merkle root'),
		time: uint32(field(object, ['time', 'timestamp', 'block_time']), 'Block time'),
		bits: compactBits(field(object, ['bits'])),
		nonce: uint32(field(object, ['nonce']), 'Block nonce'),
		transactionCount,
	};
}

function transactionIds(value: unknown): string[] {
	const unwrapped = unwrap(value);
	let items: unknown;
	if (Array.isArray(unwrapped)) items = unwrapped;
	else {
		const object = record(unwrapped, 'Block transaction response');
		items = field(object, ['tx', 'txs', 'transactions', 'items', 'results']);
	}
	if (!Array.isArray(items)) throw new Error('Block transaction response has no transaction array.');
	return items.map((item, index) => {
		if (typeof item === 'string') return normalizeHash(item, `Transaction ${index}`);
		const object = record(item, `Transaction ${index}`);
		return hashField(object, ['txid', 'id', 'hash'], `Transaction ${index} ID`);
	});
}

function nextCursor(value: unknown): string | null {
	for (const candidate of [value, unwrap(value)]) {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
		const object = candidate as JsonRecord;
		const pagination = object.pagination && typeof object.pagination === 'object' && !Array.isArray(object.pagination) ? object.pagination as JsonRecord : object;
		const cursor = field(pagination, ['next_cursor', 'nextCursor', 'cursor']);
		if (typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 512) return cursor;
	}
	return null;
}

async function request(url: URL, signal?: AbortSignal): Promise<unknown> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener('abort', abort, { once: true });
	const timer = setTimeout(() => controller.abort(), 20_000);
	try {
		const response = await fetch(url, { headers: { Accept: 'application/json, text/plain' }, cache: 'no-store', signal: controller.signal });
		if (!response.ok) throw new Error(`Provider returned HTTP ${response.status} for ${url.pathname}.`);
		const declaredLength = response.headers.get('content-length');
		if (declaredLength && integer(declaredLength, 'Provider content length') > MAX_RESPONSE_BYTES) throw new Error(`Provider response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error(`Provider response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
		const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
		if (contentType.includes('application/octet-stream')) return bytes.toString('hex');
		const body = bytes.toString('utf8').trim();
		try { return JSON.parse(body) as unknown; }
		catch { return body; }
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', abort);
	}
}

function location(value: unknown): TbcTransactionLocation {
	const object = record(unwrap(value), 'Transaction status');
	const confirmedValue = field(object, ['confirmed', 'status']);
	const confirmations = optionalInteger(field(object, ['confirmations']), 'Transaction confirmations');
	const blockHeight = optionalInteger(field(object, ['block_height', 'blockheight', 'blockHeight']), 'Transaction block height');
	const blockHashValue = field(object, ['block_hash', 'blockhash', 'blockHash']);
	const blockHash = blockHashValue === undefined || blockHashValue === null ? null
		: typeof blockHashValue === 'string' ? normalizeHash(blockHashValue, 'Transaction block hash') : (() => { throw new Error('Transaction block hash is invalid.'); })();
	const confirmed = typeof confirmedValue === 'boolean' ? confirmedValue
		: confirmedValue === 'confirmed' ? true : confirmations !== null && confirmations > 0;
	return {
		confirmed,
		blockHash,
		blockHeight,
		blockTime: optionalInteger(field(object, ['block_time', 'blocktime', 'blockTime', 'time']), 'Transaction block time'),
		confirmations,
	};
}

abstract class HttpProofSource implements TbcProofDataSource {
	abstract readonly id: string;
	constructor(readonly network: TbcNetwork, protected readonly baseUrl: string) {}
	protected url(path: string) { return new URL(path, `${this.baseUrl.replace(/\/$/, '')}/`); }
	abstract locateTransaction(txid: string, signal?: AbortSignal): Promise<TbcTransactionLocation>;
	abstract readRawTransaction(txid: string, signal?: AbortSignal): Promise<string>;
	abstract readBlock(height: number, signal?: AbortSignal): Promise<TbcBlockRecord>;
	abstract readOrderedTransactionIds(block: TbcBlockRecord, signal?: AbortSignal): Promise<string[]>;
}

export class TbcScanProofSource extends HttpProofSource {
	readonly id = 'tbcscan-api';
	constructor() {
		super('testnet', 'https://scanapi.tbcdev.org/api');
	}
	async locateTransaction(txid: string, signal?: AbortSignal) {
		const found = location(await request(this.url(`tx/${normalizeHash(txid, 'TXID')}/status`), signal));
		if (found.confirmed && found.blockHeight !== null && found.blockHash === null) {
			const block = await this.readBlock(found.blockHeight, signal);
			return { ...found, blockHash: block.hash };
		}
		return found;
	}
	async readRawTransaction(txid: string, signal?: AbortSignal) {
		const raw = rawHex(await request(this.url(`tx/${normalizeHash(txid, 'TXID')}/raw`), signal));
		if (!raw) throw new Error('TBCScan raw transaction response is invalid.');
		return raw;
	}
	async readBlock(height: number, signal?: AbortSignal) {
		const block = parseBlock(await request(this.url(`blocks/${integer(height, 'Block height')}`), signal));
		if (block.height !== height) throw new Error('TBCScan returned a different block height.');
		return block;
	}
	async readOrderedTransactionIds(block: TbcBlockRecord, signal?: AbortSignal) {
		const ids: string[] = [];
		let cursor: string | null = null;
		const seen = new Set<string>();
		while (ids.length < block.transactionCount) {
			const url = this.url(`blocks/${block.hash}/txs`);
			url.searchParams.set('limit', String(Math.min(1000, block.transactionCount - ids.length)));
			if (cursor) url.searchParams.set('cursor', cursor);
			const response = await request(url, signal);
			const page = transactionIds(response);
			if (page.length === 0) throw new Error('TBCScan returned an incomplete transaction list.');
			ids.push(...page);
			if (ids.length > block.transactionCount || ids.length > MAX_TRANSACTIONS) throw new Error('TBCScan returned too many transactions.');
			const next = nextCursor(response);
			if (ids.length === block.transactionCount) break;
			if (!next || seen.has(next)) throw new Error('TBCScan transaction pagination ended early.');
			seen.add(next); cursor = next;
		}
		return ids;
	}
}

export class OfficialTbcApiProofSource extends HttpProofSource {
	readonly id = 'official-tbc-api';
	constructor() {
		super('testnet', 'https://api.tbcdev.org/api/tbc');
	}
	async locateTransaction(txid: string, signal?: AbortSignal) {
		return location(await request(this.url(`decode/txid/${normalizeHash(txid, 'TXID')}`), signal));
	}
	async readRawTransaction(txid: string, signal?: AbortSignal) {
		const raw = rawHex(await request(this.url(`txraw/txid/${normalizeHash(txid, 'TXID')}`), signal));
		if (!raw) throw new Error('Official API raw transaction response is invalid.');
		return raw;
	}
	async readBlock(height: number, signal?: AbortSignal) {
		const block = parseBlock(await request(this.url(`blockByHeight/height/${integer(height, 'Block height')}`), signal));
		if (block.height !== height) throw new Error('Official API returned a different block height.');
		return block;
	}
	async readOrderedTransactionIds(block: TbcBlockRecord, signal?: AbortSignal) {
		const response = await request(this.url(`blockByHeight/height/${block.height}`), signal);
		const object = record(unwrap(response), 'Official block response');
		const refreshed = parseBlock(response);
		if (refreshed.hash !== block.hash) throw new Error('Official API block changed while collecting its transaction list.');
		const ids = transactionIds(field(object, ['tx', 'txs', 'transactions']));
		if (ids.length !== block.transactionCount) throw new Error('Official API returned an incomplete transaction list.');
		return ids;
	}
}
