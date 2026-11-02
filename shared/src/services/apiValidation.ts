import { ApiError } from './apiClient';
import type { ApiObject, Asset, HistoryRecord, Token, TradingPair, TransactionData, Utxo } from '../types/api';

export function isObject(value: unknown): value is ApiObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function invalidResponse(message: string): ApiError {
	return new ApiError(message, { code: 'INVALID_RESPONSE' });
}

type FieldType = 'string' | 'number' | 'boolean' | 'amount';
function fieldsMatch(value: ApiObject, fields: Record<string, FieldType>): boolean {
	return Object.entries(fields).every(([key, type]) => value[key] == null || (
		type === 'amount' ? typeof value[key] === 'string' || typeof value[key] === 'number' : typeof value[key] === type
	));
}

export function parseToken(value: unknown): Token {
	if (!isObject(value) || typeof value.contract_id !== 'string' || !fieldsMatch(value, {
		name: 'string', symbol: 'string', decimal: 'amount', balance: 'amount',
	})) throw invalidResponse('Unexpected token response.');
	return value as Token;
}

export function parseUtxo(value: unknown): Utxo {
	if (!isObject(value) || typeof value.txid !== 'string' || typeof value.index !== 'number' || !fieldsMatch(value, {
		value: 'amount', satoshis: 'amount', ft_value: 'amount', tbc_value: 'amount', decimal: 'amount', height: 'number',
	})) throw invalidResponse('Unexpected UTXO response.');
	return value as Utxo;
}

export function parseTransaction(value: unknown): TransactionData {
	if (!isObject(value) || !fieldsMatch(value, {
		contract_id: 'string', decimal: 'amount', confirmations: 'number', height: 'number', time: 'number', fee: 'amount',
	})) throw invalidResponse('Unexpected transaction response.');
	for (const key of ['input', 'output', 'vin', 'vout']) {
		const entries = value[key];
		if (entries != null && (!Array.isArray(entries) || entries.some((entry: unknown) => !isObject(entry) || !fieldsMatch(entry, {
			address: 'string', balance: 'amount', value: 'amount',
		})))) throw invalidResponse('Unexpected transaction input/output response.');
	}
	return value as TransactionData;
}

export function parseHistory(value: unknown): HistoryRecord {
	const transaction = parseTransaction(value);
	if (typeof transaction.txid !== 'string') throw invalidResponse('History record is missing a TXID.');
	return transaction as HistoryRecord;
}

export function parseAsset(value: unknown): Asset {
	if (!isObject(value) || typeof value.id !== 'string' || !fieldsMatch(value, {
		name: 'string', symbol: 'string', chain: 'string', decimals: 'amount',
	})) throw invalidResponse('Unexpected BitBus asset response.');
	return value as Asset;
}

export function parseTradingPair(value: unknown): TradingPair {
	if (!isObject(value) || typeof value.id !== 'string' || !fieldsMatch(value, { is_active: 'boolean' })) {
		throw invalidResponse('Unexpected BitBus trading pair response.');
	}
	return {
		...value,
		id: value.id,
		base_asset: value.base_asset == null ? null : parseAsset(value.base_asset),
		quote_asset: value.quote_asset == null ? null : parseAsset(value.quote_asset),
	} as TradingPair;
}
