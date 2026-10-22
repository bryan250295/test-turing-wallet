import { getNativeUtxos, getTokens, getTokenUtxos } from './tbcApi';
import type { UtxoGroup } from '../types/utxo';
import { getErrorMessage } from '../utils/errors';

export async function fetchUtxos(address: string, signal: AbortSignal) {
	const groups: UtxoGroup[] = [];
	const errors: string[] = [];
	const results = await Promise.allSettled([
		getNativeUtxos(address, { signal }),
		getTokens(address, { signal }),
	]);
	signal.throwIfAborted();

	if (results[0].status === 'fulfilled') {
		groups.push({ id: 'native', name: 'Native TBC', outputs: results[0].value });
	} else {
		errors.push(`Native TBC: ${getErrorMessage(results[0].reason)}`);
	}

	if (results[1].status === 'fulfilled') {
		// Fetch token groups in sequence to avoid flooding the public API.
		for (const token of results[1].value) {
			signal.throwIfAborted();
			try {
				const outputs = await getTokenUtxos(address, token.contract_id, { signal });
				groups.push({
					id: token.contract_id,
					name: token.name || token.symbol || 'Unnamed token',
					symbol: token.symbol,
					outputs,
				});
			} catch (error) {
				signal.throwIfAborted();
				errors.push(`${token.name || token.contract_id}: ${getErrorMessage(error)}`);
			}
		}
	} else {
		errors.push(`Token list: ${getErrorMessage(results[1].reason)}`);
	}

	return { groups, errors };
}
