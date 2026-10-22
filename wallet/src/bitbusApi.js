import { ApiError, getApiData } from './services/apiClient';
import { BITBUS_API_URLS } from './config/constants';

async function getList(endpoint, keys, options) {
	const items = [];
	const ids = new Set();
	for (let offset = 0; ; offset += 100) {
		const data = await getApiData(endpoint(offset, 100), options);
		const list = keys.map((key) => data[key]).find(Array.isArray);
		if (!list || list.some((item) => !item || typeof item.id !== 'string')) {
			throw new ApiError('Unexpected BitBus list response.', { code: 'INVALID_RESPONSE' });
		}
		let added = 0;
		for (const item of list) {
			if (!ids.has(item.id)) {
				ids.add(item.id);
				items.push(item);
				added++;
			}
		}
		if (list.length < 100 || (Number.isInteger(data.total) && offset + list.length >= data.total)) return items;
		if (!added) throw new ApiError('BitBus repeated a results page.', { code: 'INVALID_RESPONSE' });
	}
}

export async function getBitbusHealth(options) {
	const data = await getApiData(BITBUS_API_URLS.health, options);
	if (typeof data.status !== 'string') throw new ApiError('Unexpected BitBus health response.', { code: 'INVALID_RESPONSE' });
	return data;
}

export function getBitbusAssets(options) {
	return getList(BITBUS_API_URLS.assets, ['assets', 'data'], options);
}

export function getBitbusTradingPairs(options) {
	return getList(BITBUS_API_URLS.tradingPairs, ['trading_pairs'], options);
}
