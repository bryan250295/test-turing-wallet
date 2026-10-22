import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchUtxos } from '../services/utxos';
import type { UtxoState } from '../types/utxo';
import { getErrorMessage } from '../utils/errors';

const initialState: UtxoState = { loading: true, groups: [], errors: [] };

export default function useUtxos(address: string, networkIsDevnet: boolean) {
	const [state, setState] = useState(initialState);
	const request = useRef<AbortController | null>(null);

	const loadUtxos = useCallback(async () => {
		request.current?.abort();
		setState({ ...initialState });
		if (!address || !networkIsDevnet) return;

		const controller = new AbortController();
		request.current = controller;

		try {
			const { groups, errors } = await fetchUtxos(address, controller.signal);
			if (controller.signal.aborted) return;
			setState({ loading: false, groups, errors });
		} catch (error) {
			if (!controller.signal.aborted) {
				setState({ loading: false, groups: [], errors: [getErrorMessage(error)] });
			}
		} finally {
			if (request.current === controller) request.current = null;
		}
	}, [address, networkIsDevnet]);

	useEffect(() => {
		void loadUtxos();
		return () => request.current?.abort();
	}, [loadUtxos]);

	return { ...state, refresh: loadUtxos };
}
