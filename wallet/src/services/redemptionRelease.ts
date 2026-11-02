import type { BridgeOrder, RedemptionOrder, RedemptionReleaseView } from '../../../shared/src/types/learningBridge';
import { backendData } from './backendClient';
import { isObject } from './apiValidation';
const raw = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,77})$/.test(v);
const txid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const evmHash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
function path(order: BridgeOrder, row: RedemptionOrder) {
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	if (!uuid.test(order.id) || !uuid.test(row.id) || row.orderId !== order.id) throw new Error('Invalid redemption release ID.');
	return `/api/bridge/orders/${order.id}/redemption/orders/${row.id}/release`;
}
function validate(value: unknown, row: RedemptionOrder): RedemptionReleaseView {
	if (!isObject(value) || value.redemptionId !== row.id || !['awaiting_fee', 'funded', 'locked', 'signed', 'broadcasting', 'submitted', 'confirming', 'completed', 'needs_review'].includes(String(value.status))
		|| typeof value.fundingAddress !== 'string' || !/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(value.fundingAddress)
		|| !raw(value.fundingRequiredRaw) || BigInt(value.fundingRequiredRaw) < 1000n || BigInt(value.fundingRequiredRaw) > 1000000n
		|| !isObject(value.feeQuote) || !raw(value.feeQuote.feeRaw) || value.feeQuote.fundingRequiredRaw !== value.fundingRequiredRaw
		|| BigInt(value.fundingRequiredRaw) !== BigInt(value.feeQuote.feeRaw) + 1000n
		|| !Number.isSafeInteger(value.feeQuote.estimatedBytes) || Number(value.feeQuote.estimatedBytes) <= 0 || Number(value.feeQuote.estimatedBytes) > 1000000
		|| value.feeQuote.feeRateSatPerKb !== 80 || value.feeQuote.marginPercent !== 20 || value.feeQuote.nativeDecimals !== 6
		|| !date(value.createdAt) || value.checkedAt !== null && !date(value.checkedAt) || value.lastError !== null && typeof value.lastError !== 'string'
		|| value.walletLockingEnabled !== true) throw new Error('Invalid MT release funding response. Refresh saved release progress.');
	if (value.plan !== null) {
		const p = value.plan;
		if (!isObject(p) || !txid(p.planHash) || !raw(p.feeRaw) || BigInt(p.feeRaw) <= 0n || !txid(p.fundingTxid) || !Number.isSafeInteger(p.fundingVout) || Number(p.fundingVout) < 0
			|| !raw(p.fundingValueRaw) || BigInt(p.fundingValueRaw) > 1000000n || !raw(p.nativeChangeRaw) || BigInt(p.nativeChangeRaw) < 500n
			|| BigInt(p.fundingValueRaw) - BigInt(p.feeRaw) !== BigInt(p.nativeChangeRaw) || !txid(p.reserveTxid) || p.reserveVout !== 0 || p.recipient !== row.tbcRecipient || p.amountRaw !== row.amountRaw) throw new Error('The release plan differs from the frozen redemption.');
	}
	if (value.lock !== null && (!isObject(value.lock) || !evmHash(value.lock.txHash) || !Number.isSafeInteger(value.lock.logIndex) || Number(value.lock.logIndex) < 0 || !Number.isSafeInteger(value.lock.confirmations) || Number(value.lock.confirmations) < 6 || !date(value.lock.checkedAt))) throw new Error('Invalid saved permanent lock evidence.');
	if (value.signed !== null && (!isObject(value.signed) || !txid(value.signed.txid) || !raw(value.signed.feeRaw) || !isObject(value.plan) || value.signed.feeRaw !== value.plan.feeRaw || !Number.isSafeInteger(value.signed.confirmations) || Number(value.signed.confirmations) < 0 || value.signed.blockHash !== null && !txid(value.signed.blockHash))) throw new Error('Invalid saved MT release receipt.');
	if (value.status !== 'awaiting_fee' && !value.plan || ['locked', 'signed', 'broadcasting', 'submitted', 'confirming', 'completed'].includes(String(value.status)) && !value.lock
		|| ['signed', 'broadcasting', 'submitted', 'confirming', 'completed'].includes(String(value.status)) && !value.signed
		|| value.status === 'completed' && (!isObject(value.signed) || Number(value.signed.confirmations) < 6)) throw new Error('The release progress is missing required evidence.');
	return value as unknown as RedemptionReleaseView;
}
export async function getRelease(order: BridgeOrder, row: RedemptionOrder, signal: AbortSignal) {
	const value: unknown = await backendData(path(order, row), undefined, true, signal);
	return value === null ? null : validate(value, row);
}
export async function releaseAction(order: BridgeOrder, row: RedemptionOrder, action: 'open' | 'funding' | 'lock' | 'sign' | 'broadcast' | 'check', payload: unknown, signal: AbortSignal) {
	return validate(await backendData(`${path(order, row)}/${action}`, payload, true, signal), row);
}
