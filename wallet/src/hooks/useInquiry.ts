import { getErrorMessage } from '../utils/errors';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Health, Asset, TradingPair } from '../types/api';
import { getBitbusHealth, getBitbusAssets, getBitbusTradingPairs } from '../services/bitbusApi';

interface InquiryState {
	loading: boolean;
	health: Health | null;
	assets: Asset[] | null;
	pairs: TradingPair[] | null;
	errors: string[];
	updated: Date | null;
}

const initialState: InquiryState = { loading: true, health: null, assets: null, pairs: null, errors: [], updated: null };

export default function useInquiry() {
	const [state, setState] = useState(initialState);
	const request = useRef<AbortController | null>(null);

	const loadInquiry = useCallback(async () => {
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setState({ ...initialState });
		const results = await Promise.allSettled([
			getBitbusHealth({ signal: controller.signal }),
			getBitbusAssets({ signal: controller.signal }),
			getBitbusTradingPairs({ signal: controller.signal }),
		]);
		if (controller.signal.aborted) return;
		const labels = ['Service health', 'Assets', 'Trading pairs'];
		results.forEach((result, index) => {
			if (result.status === 'fulfilled') {
				console.log(`[Inquiry] ${labels[index]}:`, result.value);
			} else {
				console.error(`[Inquiry] ${labels[index]}:`, result.reason);
			}
		});
		setState({
			loading: false,
			health: results[0].status === 'fulfilled' ? results[0].value : null,
			assets: results[1].status === 'fulfilled' ? results[1].value : null,
			pairs: results[2].status === 'fulfilled' ? results[2].value : null,
			errors: results.flatMap((result, index) => result.status === 'rejected' ? [`${labels[index]}: ${getErrorMessage(result.reason)}`] : []),
			updated: new Date(),
		});
	}, []);

	useEffect(() => {
		void loadInquiry();
		return () => request.current?.abort();
	}, [loadInquiry]);

	return { ...state, refresh: loadInquiry };
}
