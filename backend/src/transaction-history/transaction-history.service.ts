import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { HistoryRecord } from '../../../shared/src/types/api';
import { getNativeHistory, getTokenHistory } from '../../../shared/src/services/tbcApi';
import { getErrorMessage } from '../../../shared/src/utils/errors';

export type HistorySource = 'Native TBC' | 'FT tokens';
export interface StreamedTransactionRow {
	txid: string;
	records: { source: HistorySource; data: HistoryRecord }[];
}
export interface TransactionHistorySnapshot {
	type: 'history';
	address: string;
	rows: StreamedTransactionRow[];
	errors: string[];
	checkedAt: string;
}

type Listener = (snapshot: TransactionHistorySnapshot) => void;
interface HistoryChannel {
	listeners: Set<Listener>;
	timer: NodeJS.Timeout;
	controller: AbortController | null;
	running: boolean;
	last: TransactionHistorySnapshot | null;
}

const POLL_INTERVAL_MS = 60_000;

function pending(row: StreamedTransactionRow) {
	return row.records.some(({ data }) => data.confirmations === 0 || data.height === -1);
}

function newest(row: StreamedTransactionRow, key: 'time' | 'height') {
	return Math.max(0, ...row.records.map(({ data }) => Number(data[key]) || 0));
}

@Injectable()
export class TransactionHistoryService implements OnModuleDestroy {
	private readonly logger = new Logger(TransactionHistoryService.name);
	private readonly channels = new Map<string, HistoryChannel>();

	subscribe(address: string, listener: Listener) {
		let channel = this.channels.get(address);
		if (!channel) {
			channel = {
				listeners: new Set(),
				timer: setInterval(() => void this.poll(address), POLL_INTERVAL_MS),
				controller: null,
				running: false,
				last: null,
			};
			this.channels.set(address, channel);
		}
		channel.listeners.add(listener);
		if (channel.last) listener(channel.last);
		else void this.poll(address);

		return () => {
			const current = this.channels.get(address);
			if (!current) return;
			current.listeners.delete(listener);
			if (current.listeners.size) return;
			clearInterval(current.timer);
			current.controller?.abort();
			this.channels.delete(address);
		};
	}

	private async poll(address: string) {
		const channel = this.channels.get(address);
		if (!channel || channel.running || !channel.listeners.size) return;
		channel.running = true;
		const controller = new AbortController();
		channel.controller = controller;
		try {
			const results = await Promise.allSettled([
				getNativeHistory(address, { signal: controller.signal }),
				getTokenHistory(address, { signal: controller.signal }),
			]);
			if (controller.signal.aborted || this.channels.get(address) !== channel) return;
			const grouped = new Map<string, StreamedTransactionRow>();
			const errors: string[] = [];
			results.forEach((result, index) => {
				const source: HistorySource = index === 0 ? 'Native TBC' : 'FT tokens';
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
			const rows = errors.length === 2 && channel.last
				? channel.last.rows
				: [...grouped.values()].sort((a, b) => Number(pending(b)) - Number(pending(a)) || newest(b, 'time') - newest(a, 'time') || newest(b, 'height') - newest(a, 'height') || a.txid.localeCompare(b.txid));
			const snapshot: TransactionHistorySnapshot = { type: 'history', address, rows, errors, checkedAt: new Date().toISOString() };
			channel.last = snapshot;
			for (const subscriber of channel.listeners) subscriber(snapshot);
		} catch (cause) {
			if (!controller.signal.aborted) this.logger.warn({ address, error: getErrorMessage(cause) }, 'Transaction history poll failed');
		} finally {
			if (this.channels.get(address) === channel) {
				channel.running = false;
				if (channel.controller === controller) channel.controller = null;
			}
		}
	}

	onModuleDestroy() {
		for (const channel of this.channels.values()) {
			clearInterval(channel.timer);
			channel.controller?.abort();
		}
		this.channels.clear();
	}
}
