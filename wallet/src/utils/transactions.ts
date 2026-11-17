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
	const history = row.records.find((record) => record.source === 'FT tokens')?.data || row.records[0].data;
	const data = row.tokenDetails;
	return { inputs: data?.input ?? data?.vin ?? history.input ?? history.vin ?? [], outputs: data?.output ?? data?.vout ?? history.output ?? history.vout ?? [] };
}

export function transactionTokenName(row: TransactionRow) {
	const token = row.records.find((record) => record.source === 'FT tokens');
	if (!token) return 'Native TBC';
	const name = row.tokenInfo?.name ?? row.tokenDetails?.name ?? token.data.name;
	return typeof name === 'string' && name.trim() ? name.trim() : 'FT token';
}

export function transactionAmount(row: TransactionRow, address: string) {
	const { inputs, outputs } = transactionParties(row);
	const token = row.records.find((record) => record.source === 'FT tokens');
	const precision = token ? row.tokenDetails?.decimal ?? row.tokenInfo?.decimal ?? token.data.decimal : 6;
	const decimals = precision == null || String(precision).trim() === '' ? NaN : Number(precision);
	const unit = token ? row.tokenInfo?.symbol || 'FT' : 'TBC';
	const amount = (entry: TransactionEntry) => {
		const value = entry.balance ?? entry.value;
		if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^\d+$/.test(String(value))) throw new Error('Invalid amount');
		return BigInt(value ?? '');
	};
	try {
		if (!Array.isArray(inputs) || !Array.isArray(outputs) || !outputs.length) return 'Unavailable';
		const sum = (items: TransactionEntry[]) => items.filter((entry) => entry.address === address).reduce((total, entry) => total + amount(entry), 0n);
		const net = sum(outputs) - sum(inputs);
		// Never present unscaled integers as a user's token balance when precision is unknown.
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return 'Unavailable';
		return `${formatHistoryAmount(net, decimals)} ${unit}`;
	} catch { return 'Unavailable'; }
}
