import { useEffect, useState } from 'react';
import { getNativeUtxos, getTokens, getTokenUtxos } from '../services/tbcApi';
import { getErrorMessage } from '../utils/errors';
import type { UtxoGroup, UtxoState } from '../types/utxo';

export default function useUtxos(address: string, networkIsDevnet: boolean) {
	const [refresh, setRefresh] = useState(0);
	const [state, setState] = useState<UtxoState>({ loading: true, groups: [], errors: [] });

	useEffect(() => {
		const controller = new AbortController();
		const { signal } = controller;
		setState({ loading: true, groups: [], errors: [] });
		if (!address || !networkIsDevnet) return () => controller.abort();

		async function load() {
			const groups: UtxoGroup[] = [];
			const errors: string[] = [];
			const results = await Promise.allSettled([
				getNativeUtxos(address, { signal }),
				getTokens(address, { signal }),
			]);
			if (results[0].status === 'fulfilled') {
				groups.push({ id: 'native', name: 'Native TBC', outputs: results[0].value });
			} else errors.push(`Native TBC: ${getErrorMessage(results[0].reason)}`);
			if (results[1].status === 'fulfilled') {
				const tokens = results[1].value;
				// Fetch token groups in sequence to avoid flooding the public API.
				for (const token of tokens) {
					if (signal.aborted) return;
					try {
						const outputs = await getTokenUtxos(address, token.contract_id, { signal });
						groups.push({ id: token.contract_id, name: token.name || token.symbol || 'Unnamed token', symbol: token.symbol, outputs });
					} catch (error) {
						errors.push(`${token.name || token.contract_id}: ${getErrorMessage(error)}`);
					}
				}
			} else errors.push(`Token list: ${getErrorMessage(results[1].reason)}`);
			if (!signal.aborted) setState({ loading: false, groups, errors });
		}
		// Start after the mount effects finish. StrictMode's initial cleanup
		// cancels this scheduled load before it can send duplicate requests.
		const loadTimer = window.setTimeout(() => {
			if (signal.aborted) return;
			load().catch((error) => {
				if (!signal.aborted) setState({ loading: false, groups: [], errors: [getErrorMessage(error)] });
			});
		}, 0);
		return () => {
			window.clearTimeout(loadTimer);
			controller.abort();
		};
	}, [address, networkIsDevnet, refresh]);

	return { ...state, refresh: () => setRefresh((value) => value + 1) };
}
