import type { TransactionRow } from '../types/transaction';
import { getNativeHistory, getTokenHistory } from './tbcApi';
import { statusOf } from '../utils/transactions';
import { getErrorMessage } from '../utils/errors';

export async function fetchTransactionHistory(address: string, signal: AbortSignal) {
	const results = await Promise.allSettled([
		getNativeHistory(address, { signal }),
		getTokenHistory(address, { signal }),
	]);
	const grouped = new Map<string, TransactionRow>();
	const errors: string[] = [];
	results.forEach((result, index) => {
		const source = index === 0 ? 'Native TBC' : 'FT tokens';
		if (result.status === 'rejected') {
			errors.push(`${source}: ${getErrorMessage(result.reason)}`);
			return;
		}
		for (const data of result.value) {
			let row = grouped.get(data.txid);
			if (!row) {
				row = { txid: data.txid, records: [] };
				grouped.set(data.txid, row);
			}
			row.records.push({ source, data });
		}
	});
	const rows = [...grouped.values()];
	const pending = (row: TransactionRow) => statusOf(row) === 'Pending';
	const newest = (row: TransactionRow, key: 'time' | 'height') => Math.max(0, ...row.records.map(({ data }) => Number(data[key]) || 0));
	rows.sort((a, b) => Number(pending(b)) - Number(pending(a)) || newest(b, 'time') - newest(a, 'time') || newest(b, 'height') - newest(a, 'height') || a.txid.localeCompare(b.txid));
	return { rows, errors };
}
