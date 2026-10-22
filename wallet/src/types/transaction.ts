import type { HistoryRecord, Token, TransactionData } from './api';

export type TransactionStatus = 'Pending' | 'Confirmed' | 'Unknown';
export interface TransactionRecord {
	source: 'Native TBC' | 'FT tokens';
	data: HistoryRecord;
}
export interface TransactionDetails {
	loaded?: boolean;
	loading?: boolean;
	error?: string;
	tokenDetails?: TransactionData;
	tokenInfo?: Token | null;
}
export interface TransactionRow extends TransactionDetails {
	txid: string;
	records: TransactionRecord[];
}
export interface ConfirmationTracking {
	address: string;
	statuses: Map<string, TransactionStatus>;
	notified: Set<string>;
}
