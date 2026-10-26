import type { RequestOptions } from './apiClient';
import type { HistoryRecord, Utxo } from '../types/api';
import { invalidResponse, parseToken, parseUtxo, parseHistory, parseTransaction } from './apiValidation';
import { getApiData } from './apiClient';
import { API_URLS } from '../config/constants';

export async function getTokens(address: string, options?: RequestOptions) {
	const data = await getApiData(API_URLS.tokenList(address), options);
	if (!Array.isArray(data.token_list)) {
		throw invalidResponse('Unexpected token list response.');
	}
	return data.token_list.map(parseToken);
}

export async function getAllUtxos(endpoint: string, options?: RequestOptions) {
	const outputs: Utxo[] = [];
	const cursors = new Set<string>();
	let cursor = '';
	do {
		const url = new URL(endpoint);
		url.searchParams.set('limit', '1000');
		if (cursor) url.searchParams.set('after', cursor);
		const data = await getApiData(url, options);
		if (!Array.isArray(data.utxos)) throw invalidResponse('Unexpected UTXO response.');
		outputs.push(...data.utxos.map(parseUtxo));
		const nextCursor = data.next_cursor ?? '';
		if (typeof nextCursor !== 'string') throw invalidResponse('Invalid UTXO pagination cursor.');
		cursor = nextCursor;
		if (cursor && cursors.has(cursor)) {
			throw invalidResponse('Invalid or repeated UTXO pagination cursor.');
		}
		cursors.add(cursor);
	} while (cursor);
	return outputs;
}

export function getNativeUtxos(address: string, options?: RequestOptions) {
	return getAllUtxos(API_URLS.nativeUtxos(address), options);
}

export function getTokenUtxos(address: string, contractId: string, options?: RequestOptions) {
	return getAllUtxos(API_URLS.tokenUtxos(address, contractId), options);
}

export async function getTransaction(txid: string, options?: RequestOptions) {
	return parseTransaction(await getApiData(API_URLS.transaction(txid), options));
}

export async function getTokenTransaction(txid: string, options?: RequestOptions) {
	return parseTransaction(await getApiData(API_URLS.tokenTransaction(txid), options));
}

export async function getTokenInfo(contractId: string, options?: RequestOptions) {
	const data = await getApiData(API_URLS.tokenInfo(contractId), options);
	return parseToken({ ...data, contract_id: data.contract_id ?? contractId });
}

async function getAllHistory(endpoint: (address: string, start: number, end: number) => string, address: string, options?: RequestOptions) {
	const records: HistoryRecord[] = [];
	const seen = new Set<string>();
	for (let start = 0; ; start += 100) {
		const data = await getApiData(endpoint(address, start, start + 100), options);
		if (!Array.isArray(data.history_list)) throw invalidResponse('Unexpected history response.');
		let added = 0;
		for (const value of data.history_list as unknown[]) {
			const item = parseHistory(value);
			const key = JSON.stringify(item);
			if (!seen.has(key)) { seen.add(key); records.push(item); added++; }
		}
		if (!data.history_list.length || (typeof data.history_count === 'number' && Number.isInteger(data.history_count) && start + data.history_list.length >= data.history_count) || data.history_list.length < 100) return records;
		if (!added) throw invalidResponse('The API repeated a history page. Refresh to retry.');
	}
}

export function getNativeHistory(address: string, options?: RequestOptions) {
	return getAllHistory(API_URLS.nativeHistory, address, options);
}

export function getTokenHistory(address: string, options?: RequestOptions) {
	return getAllHistory(API_URLS.tokenHistory, address, options);
}
