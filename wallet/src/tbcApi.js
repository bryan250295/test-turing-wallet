import { ApiError, getApiData } from './services/apiClient';
import { API_URLS } from './apiUrls';

function invalidResponse(message) {
	return new ApiError(message, { code: 'INVALID_RESPONSE' });
}

export async function getTokens(address, options) {
	const data = await getApiData(API_URLS.tokenList(address), options);
	if (!Array.isArray(data.token_list) || data.token_list.some((token) => !token || typeof token.contract_id !== 'string')) {
		throw invalidResponse('Unexpected token list response.');
	}
	return data.token_list;
}

async function getAllUtxos(endpoint, options) {
	const outputs = [];
	const cursors = new Set();
	let cursor = '';
	do {
		const url = new URL(endpoint);
		url.searchParams.set('limit', '1000');
		if (cursor) url.searchParams.set('after', cursor);
		const data = await getApiData(url, options);
		if (!Array.isArray(data.utxos)) throw invalidResponse('Unexpected UTXO response.');
		outputs.push(...data.utxos);
		cursor = data.next_cursor ?? '';
		if (typeof cursor !== 'string' || (cursor && cursors.has(cursor))) {
			throw invalidResponse('Invalid or repeated UTXO pagination cursor.');
		}
		cursors.add(cursor);
	} while (cursor);
	return outputs;
}

export function getNativeUtxos(address, options) {
	return getAllUtxos(API_URLS.nativeUtxos(address), options);
}

export function getTokenUtxos(address, contractId, options) {
	return getAllUtxos(API_URLS.tokenUtxos(address, contractId), options);
}

export function getTransaction(txid, options) {
	return getApiData(API_URLS.transaction(txid), options);
}

export function getTokenTransaction(txid, options) {
	return getApiData(API_URLS.tokenTransaction(txid), options);
}

export function getTokenInfo(contractId, options) {
	return getApiData(API_URLS.tokenInfo(contractId), options);
}

async function getAllHistory(endpoint, address, options) {
	const records = [];
	const seen = new Set();
	for (let start = 0; ; start += 100) {
		const data = await getApiData(endpoint(address, start, start + 100), options);
		if (!Array.isArray(data.history_list)) throw invalidResponse('Unexpected history response.');
		let added = 0;
		for (const item of data.history_list) {
			if (!item || typeof item.txid !== 'string') throw invalidResponse('History record is missing a TXID.');
			const key = JSON.stringify(item);
			if (!seen.has(key)) { seen.add(key); records.push(item); added++; }
		}
		if (!data.history_list.length || (Number.isInteger(data.history_count) && start + data.history_list.length >= data.history_count) || data.history_list.length < 100) return records;
		if (!added) throw invalidResponse('The API repeated a history page. Refresh to retry.');
	}
}

export function getNativeHistory(address, options) {
	return getAllHistory(API_URLS.nativeHistory, address, options);
}

export function getTokenHistory(address, options) {
	return getAllHistory(API_URLS.tokenHistory, address, options);
}
