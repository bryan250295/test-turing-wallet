import type { BridgeOrder, RedemptionOrder, RedemptionOrderInput, RedemptionEscrowDeployment } from '../../../shared/src/types/learningBridge';
import { backendData } from './backendClient';
import { isObject } from './apiValidation';
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x(?!0{64}$)[0-9a-f]{64}$/.test(v);
const raw = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,77})$/.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
function path(order: BridgeOrder) {
	if (!uuid(order.id)) throw new Error('Invalid forward order ID.');
	return `/api/bridge/orders/${order.id}/redemption/orders`;
}
function validate(value: unknown, order: BridgeOrder): RedemptionOrder {
	if (!isObject(value) || !uuid(value.id) || value.orderId !== order.id || !uuid(value.escrowId) || !uuid(value.idempotencyKey) || !hash(value.redemptionId)
		|| value.chainId !== 998 || typeof value.escrowAddress !== 'string' || !/^0x(?!0{40}$)[0-9a-f]{40}$/.test(value.escrowAddress)
		|| value.wrappedToken !== order.destinationContract || value.sourceContractId !== order.contractId || value.decimals !== order.decimals
		|| value.holder !== order.recipient.toLowerCase() || typeof value.tbcRecipient !== 'string' || !/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(value.tbcRecipient)
		|| !raw(value.amountRaw) || BigInt(value.amountRaw) <= 0n || BigInt(value.amountRaw) > BigInt(order.amountRaw)
		|| typeof value.termsHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.termsHash) || value.policyVersion !== 'permanent-escrow-preparation-v1'
		|| !['prepared', 'cancelled'].includes(String(value.status)) || !date(value.createdAt)
		|| (value.status === 'cancelled' ? !date(value.cancelledAt) : value.cancelledAt !== null)
		|| typeof value.releaseStarted !== 'boolean' || value.lockingEnabled !== false || value.sourceReleaseEnabled !== false || !isObject(value.evidence)) throw new Error('Invalid saved redemption terms. Refresh saved redemptions.');
	const e = value.evidence;
	if (typeof e.reserveTxid !== 'string' || !/^[0-9a-f]{64}$/.test(e.reserveTxid) || e.reserveVout !== 0 || e.reserveAmountRaw !== order.amountRaw
		|| typeof e.reserveBlockHash !== 'string' || !/^[0-9a-f]{64}$/.test(e.reserveBlockHash) || !Number.isSafeInteger(e.reserveConfirmations) || Number(e.reserveConfirmations) < order.sourceConfirmationsRequired
		|| !date(e.reserveCheckedAt) || !hash(e.targetBlockHash) || !raw(e.targetBlockNumber) || !raw(e.wrappedBalanceRaw) || BigInt(e.wrappedBalanceRaw) < BigInt(value.amountRaw)
		|| e.escrowPaused !== true || e.totalLockedRaw !== '0' || !date(e.checkedAt)) throw new Error('The redemption preparation evidence is incomplete.');
	return value as unknown as RedemptionOrder;
}
export async function listRedemptions(order: BridgeOrder, signal: AbortSignal) {
	const value: unknown = await backendData(path(order), undefined, true, signal);
	if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid redemption history response.');
	const rows = value.map((row) => validate(row, order));
	for (const row of rows) if (row.status === 'cancelled') forgetCancelledKey(order, row);
	return rows;
}
export async function prepareRedemption(order: BridgeOrder, escrow: RedemptionEscrowDeployment, input: RedemptionOrderInput, amountRaw: string, signal: AbortSignal) {
	const row = validate(await backendData(path(order), input, true, signal), order);
	if (row.escrowId !== escrow.id || row.escrowAddress !== escrow.contractAddress || row.holder !== input.holder.toLowerCase() || row.tbcRecipient !== input.tbcRecipient
		|| row.amountRaw !== amountRaw || row.idempotencyKey !== input.idempotencyKey) throw new Error('The saved redemption differs from the reviewed terms. Refresh saved redemptions.');
	return row;
}
export async function cancelRedemption(order: BridgeOrder, row: RedemptionOrder, signal: AbortSignal) {
	if (!uuid(row.id)) throw new Error('Invalid redemption ID.');
	const next = validate(await backendData(`${path(order)}/${row.id}/cancel`, {}, true, signal), order);
	if (next.id !== row.id || next.termsHash !== row.termsHash || next.status !== 'cancelled') throw new Error('The closed preparation differs from the saved order.');
	forgetCancelledKey(order, next);
	return next;
}
// Public idempotency pointers only. An interrupted save can be retried with the
// same frozen terms without allocating another reserve preparation.
const keys = new Map<string, string>();
function forgetCancelledKey(order: BridgeOrder, row: RedemptionOrder) {
	const context = `redemption-preparation:${order.sender}:${order.id}`;
	const terms = JSON.stringify([row.escrowId, row.holder, row.tbcRecipient, row.amountRaw]);
	if (keys.get(`${context}:${terms}`) === row.idempotencyKey) keys.delete(`${context}:${terms}`);
	try {
		const saved: unknown = JSON.parse(sessionStorage.getItem(context) ?? 'null');
		if (isObject(saved) && saved.key === row.idempotencyKey) sessionStorage.removeItem(context);
	} catch { /* A cancelled preparation is still retained in database history. */ }
}
export function redemptionRequestKey(order: BridgeOrder, terms: string) {
	const context = `redemption-preparation:${order.sender}:${order.id}`;
	try {
		const saved: unknown = JSON.parse(sessionStorage.getItem(context) ?? 'null');
		if (isObject(saved) && saved.terms === terms && uuid(saved.key)) return saved.key;
	} catch { /* In-memory retry remains available. */ }
	const key = keys.get(`${context}:${terms}`) ?? crypto.randomUUID();
	keys.set(`${context}:${terms}`, key);
	if (keys.size > 40) keys.delete(keys.keys().next().value!);
	try { sessionStorage.setItem(context, JSON.stringify({ terms, key })); } catch { /* Never store secrets. */ }
	return key;
}
