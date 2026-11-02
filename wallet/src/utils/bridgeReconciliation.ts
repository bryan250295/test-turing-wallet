import type { BridgeReconciliation, ReconciliationOrder, ReconciliationRedemption, ReconciliationRoute, ReconciliationTransaction } from '../../../shared/src/types/bridgeReconciliation';
import { formatRawAmount } from './tokenAmounts';

export type RequestStatus = 'completed' | 'pending' | 'review' | 'closed';
export interface ReconciliationRequest {
	key: string;
	id: string;
	direction: 'forward' | 'return';
	createdAt: string;
	checkedAt: string | null;
	amountRaw: string;
	recipient: string;
	status: string;
	category: RequestStatus;
	route: ReconciliationRoute;
	order: ReconciliationOrder;
	redemption: ReconciliationRedemption | null;
	transactions: ReconciliationTransaction[];
}
export const requestStatusLabels: Record<RequestStatus, string> = { completed: 'Completed', pending: 'In progress', review: 'Needs review', closed: 'Closed' };
export function requestCategory(status: string): RequestStatus {
	if (['completed', 'verified'].includes(status)) return 'completed';
	if (['cancelled', 'closed'].includes(status)) return 'closed';
	if (['needs_review', 'invalid', 'reverted'].includes(status)) return 'review';
	return 'pending';
}
export function requestStage(status: string) {
	const labels: Record<string, string> = {
		prepared: 'Order saved', awaiting_payment: 'Awaiting token payment', confirming: 'Waiting for confirmations', ready_to_mint: 'Ready to receive wrapped tokens',
		mint_pending: 'Mint in progress', awaiting_fee: 'Awaiting TBC fee payment', funded: 'Ready to approve and lock', locked: 'Ready to authorize return',
		signed: 'Ready to submit return', broadcasting: 'Check submitted transaction', submitted: 'Waiting for confirmations',
		completed: 'Completed', verified: 'Confirmed', cancelled: 'Closed', needs_review: 'Needs review', reverted: 'Transaction failed',
		invalid: 'Needs review', quoted: 'Awaiting confirmation', awaiting_wallet: 'Awaiting wallet confirmation',
		'new': 'New', 'verified when plan saved': 'Payment verified',
	};
	return labels[status] ?? status.replaceAll('_', ' ');
}
export function reconciliationAmount(raw: string, decimals: number) {
	const value = BigInt(raw);
	return `${value < 0n ? '−' : ''}${formatRawAmount(value < 0n ? -value : value, decimals)}`;
}
export function shortReference(value: string) { return value.length > 22 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
export function reconciliationRequests(report: BridgeReconciliation): ReconciliationRequest[] {
	return report.routes.flatMap((route) => route.orders.flatMap((order) => [
		{ key: `forward:${order.id}`, id: order.id, direction: 'forward' as const, createdAt: order.createdAt, checkedAt: order.checkedAt, amountRaw: order.amountRaw,
			recipient: order.recipient, status: order.status, category: requestCategory(order.status), route, order, redemption: null, transactions: order.transactions },
		...order.redemptions.map((redemption) => ({ key: `return:${redemption.id}`, id: redemption.id, direction: 'return' as const,
			createdAt: redemption.createdAt, checkedAt: redemption.checkedAt, amountRaw: redemption.amountRaw, recipient: redemption.recipient,
			status: redemption.status, category: requestCategory(redemption.status), route, order, redemption, transactions: redemption.transactions })),
	])).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.key.localeCompare(b.key));
}
export function matchesReconciliationSearch(row: ReconciliationRequest, query: string) {
	const term = query.trim().toLowerCase();
	return !term || [row.id, row.order.id, row.recipient, row.route.wrappedToken, row.route.contractId, row.route.symbol, row.route.wrappedName, row.route.wrappedSymbol,
		row.redemption?.escrowAddress ?? '', ...row.transactions.map((transaction) => transaction.hash ?? '')].some((value) => value.toLowerCase().includes(term));
}
export function recordedRequestFees(transactions: ReconciliationTransaction[]) {
	const fees: { tbc: bigint | null; hyperevm: bigint | null } = { tbc: null, hyperevm: null };
	const seen = new Set<string>();
	for (const transaction of transactions) {
		if (!transaction.hash || transaction.actualFeeRaw === null) continue;
		const key = `${transaction.network}:${transaction.hash.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key); fees[transaction.network] = (fees[transaction.network] ?? 0n) + BigInt(transaction.actualFeeRaw);
	}
	return fees;
}
