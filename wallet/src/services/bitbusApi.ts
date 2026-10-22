import type { RequestOptions } from './apiClient';
import { parseAsset, parseTradingPair } from './apiValidation';
import { ApiError, getApiData } from './apiClient';
import { BITBUS_API_URLS } from '../config/constants';

async function getList<T extends { id: string }>(endpoint: (offset: number, limit: number) => string, keys: string[], parse: (value: unknown) => T, options?: RequestOptions) {
	const items: T[] = [];
	const ids = new Set<string>();
	for (let offset = 0; ; offset += 100) {
		const data = await getApiData(endpoint(offset, 100), options);
		const list = keys.map((key) => data[key]).find((value): value is unknown[] => Array.isArray(value));
		if (!list) {
			throw new ApiError('Unexpected BitBus list response.', { code: 'INVALID_RESPONSE' });
		}
		let added = 0;
		for (const value of list) {
			const item = parse(value);
			if (!ids.has(item.id)) {
				ids.add(item.id);
				items.push(item);
				added++;
			}
		}
		if (list.length < 100 || (typeof data.total === 'number' && Number.isInteger(data.total) && offset + list.length >= data.total)) return items;
		if (!added) throw new ApiError('BitBus repeated a results page.', { code: 'INVALID_RESPONSE' });
	}
}

export async function getBitbusHealth(options?: RequestOptions) {
	const data = await getApiData(BITBUS_API_URLS.health, options);
	if (typeof data.status !== 'string') throw new ApiError('Unexpected BitBus health response.', { code: 'INVALID_RESPONSE' });
	return { ...data, status: data.status };
}

export function getBitbusAssets(options?: RequestOptions) {
	return getList(BITBUS_API_URLS.assets, ['assets', 'data'], parseAsset, options);
}

export function getBitbusTradingPairs(options?: RequestOptions) {
	return getList(BITBUS_API_URLS.tradingPairs, ['trading_pairs'], parseTradingPair, options);
}
