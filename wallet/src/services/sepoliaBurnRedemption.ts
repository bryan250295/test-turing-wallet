import { encodeFunctionData, parseAbi } from 'viem';
import type { BridgeOrder, SepoliaBurnCall, SepoliaBurnRedemption } from '../types/learningBridge';
import { isObject } from './apiValidation';
import { backendData, getBackendSession } from './backendClient';

const abi = parseAbi(['function burnForRedemption(bytes32 redemptionId,string tbcRecipient,uint256 amountRaw)']);
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const evmHash = (value: unknown) => typeof value === 'string' && /^0x(?!0{64}$)[0-9a-f]{64}$/i.test(value);
const tbcHash = (value: unknown) => typeof value === 'string' && /^(?!0{64}$)[0-9a-f]{64}$/.test(value);
const unsigned = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value);
const quantity = (value: unknown): value is string => typeof value === 'string' && /^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(value);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const statuses = ['awaiting_fee', 'prepared', 'burn_pending', 'burn_confirming', 'burn_verified', 'release_signed', 'release_broadcasting', 'release_submitted', 'release_confirming', 'completed', 'needs_review'];
const callStatuses = ['quoted', 'awaiting_wallet', 'submitted', 'confirming', 'verified', 'reverted', 'invalid', 'cancelled'];
function path(order: BridgeOrder, suffix = '') { return `/api/bridge/orders/${order.id}/sepolia-redemption${suffix}`; }
function expectedBurn(value: SepoliaBurnRedemption) {
	return encodeFunctionData({ abi, functionName: 'burnForRedemption', args: [value.redemptionKey as `0x${string}`, value.tbcRecipient, BigInt(value.amountRaw)] });
}
function validateCall(raw: unknown, order: BridgeOrder, redemption: SepoliaBurnRedemption): SepoliaBurnCall {
	if (!isObject(raw) || !uuid(raw.id) || !callStatuses.includes(String(raw.status)) || !isObject(raw.transaction)
		|| raw.transaction.from !== redemption.holder || raw.transaction.to !== order.destinationContract || raw.transaction.chainId !== '0xaa36a7' || raw.transaction.value !== '0x0'
		|| raw.transaction.data !== expectedBurn(redemption) || !quantity(raw.transaction.nonce) || !quantity(raw.transaction.gas) || !quantity(raw.transaction.gasPrice)
		|| !unsigned(raw.estimatedFeeWei) || !unsigned(raw.budgetWei) || BigInt(raw.budgetWei) !== BigInt(raw.transaction.gas) * BigInt(raw.transaction.gasPrice)
		|| BigInt(raw.estimatedFeeWei) > BigInt(raw.budgetWei) || !date(raw.expiresAt) || !date(raw.createdAt)
		|| raw.txHash !== null && !evmHash(raw.txHash) || raw.logIndex !== null && (!Number.isSafeInteger(raw.logIndex) || Number(raw.logIndex) < 0)
		|| !Number.isSafeInteger(raw.confirmations) || Number(raw.confirmations) < 0 || raw.actualFeeWei !== null && !unsigned(raw.actualFeeWei)
		|| raw.lastError !== null && typeof raw.lastError !== 'string') throw new Error('Invalid saved Sepolia burn request. No wallet action was opened.');
	return raw as unknown as SepoliaBurnCall;
}
export function validateSepoliaRedemption(raw: unknown, order: BridgeOrder): SepoliaBurnRedemption | null {
	if (raw === null) return null;
	const ft = order.sourceAssetKind === 'fungible-token';
	if (!isObject(raw) || !uuid(raw.id) || raw.orderId !== order.id || !statuses.includes(String(raw.status)) || !evmHash(raw.redemptionKey)
		|| raw.holder !== order.recipient.toLowerCase() || raw.tbcRecipient !== order.sender || raw.sourceAssetKind !== order.sourceAssetKind || raw.amountRaw !== order.amountRaw
		|| !unsigned(raw.payoutRaw) || BigInt(raw.payoutRaw) <= 0n || ft && raw.payoutRaw !== order.amountRaw
		|| !ft && (!unsigned(raw.feeRaw) || BigInt(raw.feeRaw) <= 0n || BigInt(raw.payoutRaw) + BigInt(raw.feeRaw) !== BigInt(order.amountRaw))
		|| ft && raw.status !== 'awaiting_fee' && (!unsigned(raw.feeRaw) || BigInt(raw.feeRaw) <= 0n)
		|| ft && raw.status === 'awaiting_fee' && raw.feeRaw !== null
		|| (raw.status === 'awaiting_fee' ? raw.releasePlanHash !== null : !tbcHash(raw.releasePlanHash))
		|| raw.releaseTxid !== null && !tbcHash(raw.releaseTxid) || !Number.isSafeInteger(raw.releaseConfirmations) || Number(raw.releaseConfirmations) < 0
		|| raw.releaseBlockHash !== null && !tbcHash(raw.releaseBlockHash) || raw.checkedAt !== null && !date(raw.checkedAt) || raw.lastError !== null && typeof raw.lastError !== 'string'
		|| ft && (typeof raw.fundingAddress !== 'string' || !unsigned(raw.fundingRequiredRaw) || BigInt(raw.fundingRequiredRaw) <= 0n || !isObject(raw.feeQuote)
			|| !unsigned(raw.feeQuote.feeRaw) || raw.feeQuote.fundingRequiredRaw !== raw.fundingRequiredRaw || raw.feeQuote.nativeDecimals !== 6)
		|| !ft && (raw.fundingAddress !== null || raw.fundingRequiredRaw !== null || raw.feeQuote !== null || raw.fundingTxid !== null)
		|| raw.fundingTxid !== null && !tbcHash(raw.fundingTxid)
		|| !Number.isSafeInteger(raw.fundingConfirmations) || Number(raw.fundingConfirmations) < 0
		|| raw.fundingTxid === null && raw.fundingConfirmations !== 0
		|| !date(raw.createdAt) || !Array.isArray(raw.calls) || raw.calls.length > 20) throw new Error('Invalid Sepolia burn-return response. Refresh saved progress.');
	const value = raw as unknown as SepoliaBurnRedemption;
	value.calls = value.calls.map((call) => validateCall(call, order, value));
	if (value.status === 'completed' && (!value.releaseTxid || value.releaseConfirmations < 6 || !value.calls.some((call) => call.status === 'verified' && call.confirmations >= 6))) throw new Error('The completed burn return is missing canonical burn or release evidence.');
	return value;
}
export async function getSepoliaRedemption(order: BridgeOrder, signal?: AbortSignal) { return validateSepoliaRedemption(await backendData(path(order), undefined, true, signal), order); }
export async function prepareSepoliaRedemption(order: BridgeOrder, holder: string, signal?: AbortSignal) { return validateSepoliaRedemption(await backendData(path(order), { holder, tbcRecipient: order.sender }, true, signal), order); }
export async function fundSepoliaFtRelease(order: BridgeOrder, txid: string, signal?: AbortSignal) { return validateSepoliaRedemption(await backendData(path(order, '/funding'), { txid }, true, signal), order); }
export async function quoteSepoliaBurn(order: BridgeOrder, from: string, signal?: AbortSignal) { return validateCall(await backendData(path(order, '/calls'), { from }, true, signal), order, (await getSepoliaRedemption(order, signal))!); }
export async function beginSepoliaBurn(order: BridgeOrder, redemption: SepoliaBurnRedemption, call: SepoliaBurnCall, signal?: AbortSignal) {
	const next = validateCall(await backendData(path(order, `/calls/${call.id}/begin`), {}, true, signal), order, redemption);
	if (next.status !== 'awaiting_wallet' || JSON.stringify(next.transaction) !== JSON.stringify(call.transaction)) throw new Error('The saved burn authorization differs from the reviewed quote.');
	return next;
}
export async function submitSepoliaBurn(order: BridgeOrder, redemption: SepoliaBurnRedemption, call: SepoliaBurnCall, txHash: string) {
	if (!evmHash(txHash) || getBackendSession()?.identity.address !== order.sender) throw new Error('Reconnect the original TBC wallet and use the Sepolia hash from MetaMask Activity.');
	return validateCall(await backendData(path(order, `/calls/${call.id}/submit`), { txHash }, true), order, redemption);
}
export async function cancelSepoliaBurn(order: BridgeOrder, redemption: SepoliaBurnRedemption, call: SepoliaBurnCall) { return validateCall(await backendData(path(order, `/calls/${call.id}/cancel`), { notSent: true }, true), order, redemption); }
export async function checkSepoliaBurn(order: BridgeOrder, call: SepoliaBurnCall, signal?: AbortSignal) { return validateSepoliaRedemption(await backendData(path(order, `/calls/${call.id}/check`), {}, true, signal), order); }
export async function broadcastNativeRelease(order: BridgeOrder, redemption: SepoliaBurnRedemption, signal?: AbortSignal) { return validateSepoliaRedemption(await backendData(path(order, '/release/broadcast'), { planHash: redemption.releasePlanHash, authorize: true }, true, signal), order); }
export async function checkNativeRelease(order: BridgeOrder, signal?: AbortSignal) { return validateSepoliaRedemption(await backendData(path(order, '/release/check'), {}, true, signal), order); }
