import { useEffect, useRef, useState } from 'react';
import { getTokenTransaction, getTokenInfo } from '../services/tbcApi';
import { detectConfirmations, statusOf } from '../utils/transactions';
import { getErrorMessage } from '../utils/errors';
import type { TransactionData } from '../types/api';
import type { TransactionRow, TransactionDetails, ConfirmationTracking } from '../types/transaction';
import { openBoundedWebSocket, type BoundedSocketState } from '../utils/boundedWebSocket';

type RealtimeState = BoundedSocketState;
const detailVersion = (row: TransactionRow) => `${statusOf(row)}:${row.records.find(({ source }) => source === 'FT tokens')?.data.contract_id ?? ''}`;
interface HistorySnapshot {
	type: 'history';
	address: string;
	rows: TransactionRow[];
	errors: string[];
	checkedAt: string;
}

function parseSnapshot(value: unknown): HistorySnapshot {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid live history message.');
	const snapshot = value as Record<string, unknown>;
	if (snapshot.type !== 'history' || typeof snapshot.address !== 'string' || !Array.isArray(snapshot.rows) || !Array.isArray(snapshot.errors) || typeof snapshot.checkedAt !== 'string' || !Number.isFinite(new Date(snapshot.checkedAt).getTime())) throw new Error('Invalid live history message.');
	const rows = snapshot.rows.map((value) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid live transaction row.');
		const row = value as Record<string, unknown>;
		if (typeof row.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(row.txid) || !Array.isArray(row.records)) throw new Error('Invalid live transaction row.');
		const records = row.records.map((value) => {
			if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid live transaction record.');
			const record = value as Record<string, unknown>;
			if ((record.source !== 'Native TBC' && record.source !== 'FT tokens') || !record.data || typeof record.data !== 'object' || Array.isArray(record.data) || (record.data as Record<string, unknown>).txid !== row.txid) throw new Error('Invalid live transaction record.');
			return { source: record.source, data: record.data } as TransactionRow['records'][number];
		});
		return { txid: row.txid.toLowerCase(), records };
	});
	if (!snapshot.errors.every((error) => typeof error === 'string')) throw new Error('Invalid live history errors.');
	return { type: 'history', address: snapshot.address, rows, errors: snapshot.errors as string[], checkedAt: snapshot.checkedAt };
}

export default function useTransactionHistory(address: string, networkIsDevnet: boolean, hidden: boolean | undefined, notifyConfirmation: (txid: string) => void) {
	const detailRequests = useRef(new Map<string, AbortController>());
	const detailVersions = useRef(new Map<string, string>());
	const [detailsByTxid, setDetailsByTxid] = useState<Record<string, TransactionDetails>>({});
	const observed = useRef<ConfirmationTracking>({ address: '', statuses: new Map(), notified: new Set() });
	const [state, setState] = useState<{ address: string; loading: boolean; rows: TransactionRow[]; errors: string[] }>({ address: '', loading: true, rows: [], errors: [] });
	const [realtime, setRealtime] = useState<RealtimeState>('off');
	const [checkedAt, setCheckedAt] = useState('');

	useEffect(() => {
		for (const controller of detailRequests.current.values()) controller.abort();
		detailRequests.current.clear();
		detailVersions.current.clear();
		setDetailsByTxid({});
		setCheckedAt('');
		if (hidden || !address || !networkIsDevnet) {
			setRealtime('off');
			return;
		}
		if (observed.current.address !== address) {
			observed.current = { address, statuses: new Map(), notified: new Set() };
		}
		setState((previous) => previous.address === address
			? { ...previous, loading: true, errors: [] }
			: { address, loading: true, rows: [], errors: [] });

		const controller = new AbortController();
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const disconnect = openBoundedWebSocket({
			url: `${protocol}//${window.location.host}/api/transaction-history/ws`, signal: controller.signal,
			onState: (next) => {
				setRealtime(next);
				if (next === 'reconnecting' || next === 'stopped') setState((previous) => ({ ...previous, loading: false }));
			},
			onMessage: (data) => {
				try {
					const snapshot = parseSnapshot(JSON.parse(data));
					if (snapshot.address !== address) throw new Error('Live history identity mismatch.');
					const stale = snapshot.rows.filter((row) => detailVersions.current.has(row.txid) && detailVersions.current.get(row.txid) !== detailVersion(row)).map((row) => row.txid);
					for (const txid of stale) {
						detailRequests.current.get(txid)?.abort();
						detailRequests.current.delete(txid);
						detailVersions.current.delete(txid);
					}
					if (stale.length) setDetailsByTxid((previous) => Object.fromEntries(Object.entries(previous).filter(([txid]) => !stale.includes(txid))));
					const confirmedTxids = detectConfirmations(snapshot.rows, observed.current);
					confirmedTxids.forEach(notifyConfirmation);
					setState({ address, loading: false, rows: snapshot.rows, errors: snapshot.errors });
					setCheckedAt(snapshot.checkedAt);
				} catch (error) {
					setState((previous) => ({ ...previous, loading: false, errors: [getErrorMessage(error)] }));
					throw error;
				}
			},
		});
		return () => {
			controller.abort();
			disconnect();
			for (const controller of detailRequests.current.values()) controller.abort();
			detailRequests.current.clear();
		};
	}, [address, networkIsDevnet, hidden, notifyConfirmation]);

	async function loadTransactionDetails(row: TransactionRow) {
		if (!row.records.some((record) => record.source === 'FT tokens') ||
			(detailsByTxid[row.txid]?.loaded && detailVersions.current.get(row.txid) === detailVersion(row)) || detailRequests.current.has(row.txid)) return;
		const controller = new AbortController();
		detailRequests.current.set(row.txid, controller);
		detailVersions.current.set(row.txid, detailVersion(row));
		setDetailsByTxid((previous) => ({ ...previous, [row.txid]: { ...previous[row.txid], loading: true, error: '' } }));
		let tokenDetails: TransactionData | undefined;
		try {
			tokenDetails = await getTokenTransaction(row.txid, { signal: controller.signal });
			const contractId = tokenDetails.contract_id ?? row.records.find((record) => record.source === 'FT tokens')?.data.contract_id;
			const tokenInfo = contractId
				? await getTokenInfo(contractId, { signal: controller.signal })
				: null;
			const precision = tokenDetails.decimal ?? tokenInfo?.decimal;
			const decimals = precision == null || String(precision).trim() === '' ? NaN : Number(precision);
			const complete = Boolean((tokenDetails.output ?? tokenDetails.vout)?.length && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 && tokenInfo?.name);
			if (!controller.signal.aborted) setDetailsByTxid((previous) => ({
				...previous, [row.txid]: { loaded: complete, loading: false, tokenDetails, tokenInfo },
			}));
		} catch (error) {
			if (!controller.signal.aborted) setDetailsByTxid((previous) => ({
				...previous, [row.txid]: { loading: false, tokenDetails, error: getErrorMessage(error) },
			}));
		} finally {
			if (detailRequests.current.get(row.txid) === controller) detailRequests.current.delete(row.txid);
		}
	}

	return { state, detailsByTxid, realtime, checkedAt, loadTransactionDetails };
}
