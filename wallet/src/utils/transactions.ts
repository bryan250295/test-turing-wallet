import type { Amount, TransactionEntry } from '../types/api';
import type { TransactionRow, ConfirmationTracking } from '../types/transaction';
import { formatDateTime } from './dateTime';

export function statusOf(row: TransactionRow) {
	if (row.records.some(({ data }) => data.confirmations === 0 || data.height === -1)) {
		return 'Pending';
	}
	if (row.records.some(({ data }) => (data.confirmations ?? 0) > 0)) {
		return 'Confirmed';
	}
	return 'Unknown';
}

export function detectConfirmations(rows: TransactionRow[], tracking: ConfirmationTracking) {
	const confirmedTxids: string[] = [];
	for (const row of rows) {
		const status = statusOf(row);
		if (tracking.statuses.get(row.txid) === 'Pending' && status === 'Confirmed' && !tracking.notified.has(row.txid)) {
			tracking.notified.add(row.txid);
			confirmedTxids.push(row.txid);
		}
		// A missing record or failed fetch is not proof that a transaction failed.
		tracking.statuses.set(row.txid, status);
	}
	return confirmedTxids;
}

export const shortId = (value: string) => `${value.slice(0, 10)}…${value.slice(-8)}`;
export const timeOf = (row: TransactionRow) => Math.max(0, ...row.records.map(({ data }) => Number(data.time) || 0));
export const dateOf = (time: number) => time ? formatDateTime(time) : 'Awaiting confirmation';

export function formatHistoryAmount(raw: bigint, decimals: number) {
	const negative = raw < 0n;
	const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
	const whole = decimals ? digits.slice(0, -decimals) : digits;
	const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, '') : '';
	return `${negative ? '−' : raw > 0n ? '+' : ''}${BigInt(whole).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
}

export function formatFeeTbc(satoshis: Amount) {
	if ((typeof satoshis === 'number' && !Number.isSafeInteger(satoshis)) || !/^\d+$/.test(String(satoshis))) return 'Unavailable';
	// TBCNODE defines TBCCOIN as 1,000,000 satoshis (6 decimal places).
	return `${formatHistoryAmount(BigInt(satoshis), 6).replace(/^\+/, '')} TBC`;
}

export function transactionParties(row: TransactionRow) {
	const data = row.tokenDetails || row.records.find((record) => record.source === 'FT tokens')?.data || row.records[0].data;
	return { inputs: data.input || data.vin || [], outputs: data.output || data.vout || [] };
}

export function transactionAmount(row: TransactionRow, address: string) {
	const { inputs, outputs } = transactionParties(row);
	const token = row.records.some((record) => record.source === 'FT tokens');
	const decimals = token ? Number(row.tokenDetails?.decimal ?? row.tokenInfo?.decimal ?? row.records[0].data.decimal) : 0;
	const unit = token ? row.tokenInfo?.symbol || 'token units' : 'satoshis';
	const amount = (entry: TransactionEntry) => {
		const value = entry.balance ?? entry.value;
		if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^\d+$/.test(String(value))) throw new Error('Invalid amount');
		return BigInt(value ?? '');
	};
	try {
		if (!Array.isArray(inputs) || !Array.isArray(outputs) || !outputs.length) return 'Unavailable';
		const sum = (items: TransactionEntry[]) => items.filter((entry) => entry.address === address).reduce((total, entry) => total + amount(entry), 0n);
		const net = sum(outputs) - sum(inputs);
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return `${formatHistoryAmount(net, 0)} raw units`;
		return `${formatHistoryAmount(net, decimals)} ${unit}`;
	} catch { return 'Unavailable'; }
}
