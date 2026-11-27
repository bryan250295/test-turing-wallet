import type { BridgeReconciliation, ReconciliationDraft, ReconciliationOrder, ReconciliationRedemption, ReconciliationRoute, ReconciliationSepoliaReturn, ReconciliationTransaction } from '../../../shared/src/types/bridgeReconciliation';
import { formatRawAmount } from './tokenAmounts';

export type RequestStatus = 'completed' | 'pending' | 'review' | 'closed';
export type ReconciliationRequestRoute = Pick<ReconciliationRoute, 'deploymentId' | 'destinationChainId' | 'wrappedToken' | 'contractId' | 'decimals' | 'symbol' | 'wrappedName' | 'wrappedSymbol'>;
export interface ReconciliationRequest {
	key: string;
	id: string;
	direction: 'forward' | 'return';
	createdAt: string;
	checkedAt: string | null;
	amountRaw: string | null;
	recipient: string | null;
	status: string;
	category: RequestStatus;
	route: ReconciliationRequestRoute;
	order: ReconciliationOrder | null;
	draft: ReconciliationDraft | null;
	redemption: ReconciliationRedemption | null;
	sepoliaReturn: ReconciliationSepoliaReturn | null;
	transactions: ReconciliationTransaction[];
}
export const requestStatusLabels: Record<RequestStatus, string> = { completed: 'Completed', pending: 'In progress', review: 'Needs review', closed: 'Closed' };
export function routeDestinationName(route: ReconciliationRequestRoute) {
	return route.destinationChainId === 11_155_111 ? 'Ethereum Sepolia' : 'HyperEVM Testnet';
}
export function routeDirectionLabel(route: ReconciliationRequestRoute, direction: 'forward' | 'return') {
	const destination = routeDestinationName(route).replace(' Testnet', '');
	return direction === 'forward' ? `TBC → ${destination}` : `${destination} → TBC`;
}
export function requestDirectionLabel(request: ReconciliationRequest) {
	if (request.sepoliaReturn) return `TBC ↔ ${routeDestinationName(request.route).replace(' Testnet', '')}`;
	return routeDirectionLabel(request.route, request.direction);
}
export function requestFlowLabel(request: ReconciliationRequest) {
	if (request.sepoliaReturn) return `${request.route.symbol} → ${request.route.wrappedSymbol} → ${request.route.symbol}`;
	return request.direction === 'forward' ? `${request.route.symbol} → ${request.route.wrappedSymbol}` : `${request.route.wrappedSymbol} → ${request.route.symbol}`;
}
export function requestStatusLabel(request: ReconciliationRequest) {
	if (request.draft) return 'Draft';
	if (request.sepoliaReturn?.status === 'completed') return 'Round trip complete';
	if (request.category !== 'pending') return requestStatusLabels[request.category];
	if (request.sepoliaReturn) {
		const steps: Record<string, string> = {
			awaiting_fee: 'Return 1/5 · Fund fee',
			prepared: 'Return 2/5 · Review burn',
			burn_pending: `Return 3/5 · Burn ${request.route.wrappedSymbol}`,
			burn_confirming: 'Return 4/5 · Verify burn',
			burn_verified: `Return 5/5 · Receive ${request.route.symbol}`,
			release_signed: `Return 5/5 · Receive ${request.route.symbol}`,
			release_broadcasting: `Return 5/5 · Receive ${request.route.symbol}`,
			release_submitted: `Return 5/5 · Receive ${request.route.symbol}`,
			release_confirming: `Return 5/5 · Receive ${request.route.symbol}`,
		};
		return steps[request.status] ?? requestStage(request.status);
	}
	if (request.redemption || request.direction === 'return') {
		const steps: Record<string, string> = {
			prepared: 'Return 1/4 · Prepare fee', awaiting_fee: 'Return 1/4 · Fund fee',
			funded: `Return 2/4 · Lock ${request.route.wrappedSymbol}`,
			locked: 'Return 3/4 · Authorize return',
			signed: `Return 4/4 · Receive ${request.route.symbol}`,
			broadcasting: `Return 4/4 · Receive ${request.route.symbol}`,
			submitted: `Return 4/4 · Receive ${request.route.symbol}`,
			confirming: `Return 4/4 · Receive ${request.route.symbol}`,
		};
		return steps[request.status] ?? requestStage(request.status);
	}
	const steps: Record<string, string> = {
		prepared: `Bridge 1/4 · Pay ${request.route.symbol}`,
		awaiting_payment: `Bridge 1/4 · Pay ${request.route.symbol}`,
		confirming: 'Bridge 2/4 · Confirm deposit',
		ready_to_mint: `Bridge 3/4 · Mint ${request.route.wrappedSymbol}`,
		mint_pending: `Bridge 3/4 · Mint ${request.route.wrappedSymbol}`,
	};
	return steps[request.status] ?? requestStage(request.status);
}
export function requestStageLabel(request: ReconciliationRequest) {
	return request.draft ? 'Route saved · add amount and receiving wallet' : request.sepoliaReturn?.status === 'completed' ? 'Forward mint, wrapped-token burn and TBC release verified' : requestStage(request.status);
}
export function routeFeeSymbol(route: ReconciliationRequestRoute) { return route.destinationChainId === 11_155_111 ? 'ETH' : 'HYPE'; }
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
		burn_pending: 'Waiting for wrapped-token burn', burn_confirming: 'Verifying burn confirmations', burn_verified: 'Burn verified · preparing TBC release',
		release_signed: 'TBC release signed · submitting automatically', release_broadcasting: 'Submitting saved TBC release',
		release_submitted: 'Waiting for TBC release confirmations', release_confirming: 'Waiting for TBC release confirmations',
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
	return [...report.drafts.map((draft): ReconciliationRequest => ({ key: `draft:${draft.id}`, id: draft.id, direction: 'forward', createdAt: draft.createdAt,
		checkedAt: null, amountRaw: null, recipient: null, status: 'draft', category: 'pending', route: draft, order: null, draft,
		redemption: null, sepoliaReturn: null, transactions: [] })), ...report.routes.flatMap((route) => route.orders.flatMap((order) => [
		{ key: `forward:${order.id}`, id: order.id, direction: 'forward' as const, createdAt: order.createdAt, checkedAt: order.sepoliaReturn?.checkedAt ?? order.checkedAt, amountRaw: order.amountRaw,
			recipient: order.recipient, status: order.sepoliaReturn?.status ?? order.status, category: requestCategory(order.sepoliaReturn?.status ?? order.status), route, order,
			draft: null, redemption: null, sepoliaReturn: order.sepoliaReturn, transactions: [...order.transactions, ...(order.sepoliaReturn?.transactions ?? [])] },
		...order.redemptions.map((redemption) => ({ key: `return:${redemption.id}`, id: redemption.id, direction: 'return' as const,
			createdAt: redemption.createdAt, checkedAt: redemption.checkedAt, amountRaw: redemption.amountRaw, recipient: redemption.recipient,
			status: redemption.status, category: requestCategory(redemption.status), route, order, draft: null, redemption, sepoliaReturn: null, transactions: redemption.transactions })),
	]))].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.key.localeCompare(b.key));
}
export function matchesReconciliationSearch(row: ReconciliationRequest, query: string) {
	const term = query.trim().toLowerCase();
	return !term || [row.id, row.order?.id ?? '', row.recipient ?? '', row.route.wrappedToken, row.route.contractId, row.route.symbol, row.route.wrappedName, row.route.wrappedSymbol,
		row.redemption?.escrowAddress ?? '', row.sepoliaReturn?.recipient ?? '', row.sepoliaReturn?.holder ?? '', ...row.transactions.map((transaction) => transaction.hash ?? '')].some((value) => value.toLowerCase().includes(term));
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
