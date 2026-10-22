import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTransactionHistory } from '../services/transactionHistory';
import { getTokenTransaction, getTokenInfo } from '../services/tbcApi';
import { detectConfirmations } from '../utils/transactions';
import { getErrorMessage } from '../utils/errors';
import type { TransactionData } from '../types/api';
import type { TransactionRow, TransactionDetails, ConfirmationTracking } from '../types/transaction';

export default function useTransactionHistory(address: string, networkIsDevnet: boolean, hidden: boolean | undefined, notifyConfirmation: (txid: string) => void) {
	const historyRequest = useRef<AbortController | null>(null);
	const detailRequests = useRef(new Map<string, AbortController>());
	const [detailsByTxid, setDetailsByTxid] = useState<Record<string, TransactionDetails>>({});
	const observed = useRef<ConfirmationTracking>({ address: '', statuses: new Map(), notified: new Set() });
	const [state, setState] = useState<{ address: string; loading: boolean; rows: TransactionRow[]; errors: string[] }>({ address: '', loading: true, rows: [], errors: [] });
	const loadHistory = useCallback(async () => {
		historyRequest.current?.abort();
		for (const controller of detailRequests.current.values()) controller.abort();
		detailRequests.current.clear();
		setDetailsByTxid({});
		if (hidden || !address || !networkIsDevnet) return;

		const controller = new AbortController();
		historyRequest.current = controller;
		if (observed.current.address !== address) {
			observed.current = { address, statuses: new Map(), notified: new Set() };
		}
		setState((previous) => previous.address === address
			? { ...previous, loading: true, errors: [] }
			: { address, loading: true, rows: [], errors: [] });

		try {
			const { rows, errors } = await fetchTransactionHistory(address, controller.signal);
			if (controller.signal.aborted) return;

			const confirmedTxids = detectConfirmations(rows, observed.current);
			confirmedTxids.forEach(notifyConfirmation);
			setState((previous) => ({
				address,
				loading: false,
				rows: errors.length === 2 ? previous.rows : rows,
				errors,
			}));
		} catch (error) {
			if (!controller.signal.aborted) {
				setState((previous) => ({ ...previous, loading: false, errors: [getErrorMessage(error)] }));
			}
		} finally {
			if (historyRequest.current === controller) historyRequest.current = null;
		}
	}, [address, networkIsDevnet, hidden, notifyConfirmation]);

	useEffect(() => {
		void loadHistory();
		return () => {
			historyRequest.current?.abort();
			for (const controller of detailRequests.current.values()) controller.abort();
			detailRequests.current.clear();
		};
	}, [loadHistory]);

	async function loadTransactionDetails(row: TransactionRow) {
		if (!row.records.some((record) => record.source === 'FT tokens') ||
			detailsByTxid[row.txid]?.loaded || detailRequests.current.has(row.txid)) return;
		const controller = new AbortController();
		detailRequests.current.set(row.txid, controller);
		setDetailsByTxid((previous) => ({ ...previous, [row.txid]: { ...previous[row.txid], loading: true, error: '' } }));
		let tokenDetails: TransactionData | undefined;
		try {
			tokenDetails = await getTokenTransaction(row.txid, { signal: controller.signal });
			const tokenInfo = tokenDetails.contract_id
				? await getTokenInfo(tokenDetails.contract_id, { signal: controller.signal })
				: null;
			if (!controller.signal.aborted) setDetailsByTxid((previous) => ({
				...previous, [row.txid]: { loaded: true, loading: false, tokenDetails, tokenInfo },
			}));
		} catch (error) {
			if (!controller.signal.aborted) setDetailsByTxid((previous) => ({
				...previous, [row.txid]: { loading: false, tokenDetails, error: getErrorMessage(error) },
			}));
		} finally {
			if (detailRequests.current.get(row.txid) === controller) detailRequests.current.delete(row.txid);
		}
	}

	return { state, detailsByTxid, refresh: loadHistory, loadTransactionDetails };
}
