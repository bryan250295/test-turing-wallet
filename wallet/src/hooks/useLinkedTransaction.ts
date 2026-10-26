import { useEffect, useState } from 'react';
import { getTransaction, getTokenTransaction } from '../services/tbcApi';
import type { TransactionRow } from '../types/transaction';
import { getErrorMessage } from '../utils/errors';

interface LinkedTransactionState {
	txid: string;
	row?: TransactionRow;
	loading: boolean;
	error?: string;
}

// Look up an explicit TXID when it is absent from the connected wallet's history.
export default function useLinkedTransaction(txid: string, enabled: boolean): LinkedTransactionState {
	const [state, setState] = useState<LinkedTransactionState>({ txid: '', loading: false });
	useEffect(() => {
		if (!enabled || !txid) return;
		const controller = new AbortController();
		setState({ txid, loading: true });
		void Promise.allSettled([
			getTransaction(txid, { signal: controller.signal }),
			getTokenTransaction(txid, { signal: controller.signal }),
		]).then((results) => {
			if (controller.signal.aborted) return;
			const row: TransactionRow = { txid, records: [] };
			results.forEach((result, index) => {
				if (result.status === 'fulfilled') row.records.push({ source: index === 0 ? 'Native TBC' : 'FT tokens', data: { ...result.value, txid } });
			});
			setState(row.records.length ? { txid, row, loading: false } : { txid, loading: false, error: `Could not load transaction ${txid}. ${results.filter((result) => result.status === 'rejected').map((result) => getErrorMessage(result.reason)).join(' ')}` });
		});
		return () => controller.abort();
	}, [txid, enabled]);
	return state.txid === txid && enabled ? state : { txid, loading: false };
}
