import type { BridgeCallAttempt, BridgeCallKind, BridgeOrder, BridgeSettlement } from '../types/learningBridge';
import { isObject } from './apiValidation';
import { backendData, getBackendSession } from './backendClient';

const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^0x(?!0{64}$)[0-9a-f]{64}$/.test(value);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const unsigned = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value);
const quantity = (value: unknown): value is string => typeof value === 'string' && /^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(value);
const address = (value: unknown) => typeof value === 'string' && /^0x(?!0{40}$)[0-9a-f]{40}$/.test(value);
const states = ['awaiting_payment', 'confirming', 'ready_to_mint', 'mint_pending', 'completed', 'needs_review'];
function path(orderId: string, suffix = '') { if (!uuid(orderId)) throw new Error('Invalid bridge order ID.'); return `/api/bridge/orders/${orderId}/settlement${suffix}`; }
function callPath(orderId: string, attemptId: string, action: string) { if (!uuid(attemptId)) throw new Error('Invalid wallet call ID.'); return path(orderId, `/calls/${attemptId}/${action}`); }
async function expectedData(order: BridgeOrder, kind: BridgeCallKind, settlement: BridgeSettlement | null) {
	if (kind === 'unpause') return '0x3f4ba83a';
	if (!settlement?.deposit) throw new Error('No verified deposit is available for mint.');
	const key = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`learning-bridge/order/v1:${order.id}`));
	const orderKey = Array.from(new Uint8Array(key), (byte) => byte.toString(16).padStart(2, '0')).join('');
	const word = (value: bigint) => value.toString(16).padStart(64, '0');
	return `0xbf31ca75${orderKey}${order.contractId}${settlement.deposit.txid}${word(BigInt(settlement.deposit.vout))}${order.recipient.slice(2).toLowerCase().padStart(64, '0')}${word(BigInt(order.amountRaw))}`;
}
export async function validateBridgeCall(value: unknown, order: BridgeOrder, settlement: BridgeSettlement | null): Promise<BridgeCallAttempt> {
	if (!isObject(value) || !uuid(value.id) || !['unpause', 'mint'].includes(String(value.kind))
		|| !['quoted', 'awaiting_wallet', 'submitted', 'confirming', 'verified', 'reverted', 'invalid', 'cancelled'].includes(String(value.status))
		|| !isObject(value.transaction) || !address(value.transaction.from) || value.transaction.to !== order.destinationContract || value.transaction.chainId !== '0x3e6' || value.transaction.value !== '0x0'
		|| !quantity(value.transaction.gas) || !quantity(value.transaction.gasPrice) || !quantity(value.transaction.nonce)
		|| !unsigned(value.estimatedFeeWei) || !unsigned(value.budgetWei) || BigInt(value.estimatedFeeWei) <= 0n || BigInt(value.budgetWei) <= 0n
		|| BigInt(value.transaction.gas) > 50_000_000n || BigInt(value.transaction.nonce) > BigInt(Number.MAX_SAFE_INTEGER)
		|| BigInt(value.budgetWei) !== BigInt(value.transaction.gas) * BigInt(value.transaction.gasPrice) || BigInt(value.estimatedFeeWei) > BigInt(value.budgetWei)
		|| !date(value.expiresAt) || !date(value.createdAt) || value.txHash !== null && !hash(value.txHash)
		|| typeof value.confirmations !== 'number' || !Number.isSafeInteger(value.confirmations) || value.confirmations < 0
		|| value.actualFeeWei !== null && !unsigned(value.actualFeeWei) || value.lastError !== null && typeof value.lastError !== 'string') throw new Error('Invalid bridge wallet-call response. Refresh saved progress.');
	if (value.transaction.data !== await expectedData(order, value.kind as BridgeCallKind, settlement)) throw new Error('Wallet calldata differs from the frozen order or source deposit. No wallet request was opened.');
	return value as unknown as BridgeCallAttempt;
}
async function validateSettlement(value: unknown, order: BridgeOrder): Promise<BridgeSettlement | null> {
	if (value === null) return null;
	if (!isObject(value) || value.orderId !== order.id || !states.includes(String(value.status))
		|| typeof value.custodyAddress !== 'string' || !/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(value.custodyAddress)
		|| !date(value.paymentOpenedAt) || value.checkedAt !== null && !date(value.checkedAt) || value.lastError !== null && typeof value.lastError !== 'string'
		|| !Array.isArray(value.attempts) || value.attempts.length > 20) throw new Error('Invalid bridge settlement response. Refresh saved progress.');
	const deposit = value.deposit;
	if (deposit !== null && (!isObject(deposit) || typeof deposit.txid !== 'string' || !/^(?!0{64}$)[0-9a-f]{64}$/.test(deposit.txid) || deposit.vout !== 0
		|| deposit.amountRaw !== order.amountRaw || !unsigned(deposit.feeRaw) || BigInt(deposit.feeRaw) <= 0n || typeof deposit.confirmations !== 'number' || !Number.isSafeInteger(deposit.confirmations) || deposit.confirmations < 0
		|| !date(deposit.checkedAt) || deposit.blockHash !== null && (typeof deposit.blockHash !== 'string' || !/^[0-9a-f]{64}$/.test(deposit.blockHash))
		|| deposit.blockHeight !== null && (typeof deposit.blockHeight !== 'number' || !Number.isSafeInteger(deposit.blockHeight) || deposit.blockHeight < 0))) throw new Error('The source deposit response differs from this order.');
	const result = value as unknown as BridgeSettlement;
	result.attempts = await Promise.all(result.attempts.map((row) => validateBridgeCall(row, order, result)));
	if (result.status === 'completed' && (!result.deposit || result.deposit.confirmations < order.sourceConfirmationsRequired || !result.attempts.some((row) => row.kind === 'mint' && row.status === 'verified' && row.confirmations >= order.destinationConfirmationsRequired))) throw new Error('The completed settlement is missing its chain evidence.');
	return result;
}
export async function getSettlement(order: BridgeOrder, signal: AbortSignal) { return validateSettlement(await backendData(path(order.id), undefined, true, signal), order); }
export async function openPayment(order: BridgeOrder, signal: AbortSignal) { return validateSettlement(await backendData(path(order.id, '/open'), { acknowledged: true }, true, signal), order); }
export async function checkDeposit(order: BridgeOrder, txid: string | undefined, signal: AbortSignal) { return validateSettlement(await backendData(path(order.id, '/deposit'), txid ? { txid: txid.trim().toLowerCase() } : {}, true, signal), order); }
export async function quoteCall(order: BridgeOrder, settlement: BridgeSettlement, kind: BridgeCallKind | 'next', from: string, signal: AbortSignal) { return validateBridgeCall(await backendData(path(order.id, '/calls'), { kind, from }, true, signal), order, settlement); }
export async function beginCall(order: BridgeOrder, settlement: BridgeSettlement, row: BridgeCallAttempt, signal: AbortSignal) {
	const next = await validateBridgeCall(await backendData(callPath(order.id, row.id, 'begin'), {}, true, signal), order, settlement);
	if (next.status !== 'awaiting_wallet' || JSON.stringify(next.transaction) !== JSON.stringify(row.transaction)) throw new Error('The wallet send authorization differs from your reviewed quote. Refresh saved progress.');
	return next;
}
export async function submitCall(order: BridgeOrder, settlement: BridgeSettlement, row: BridgeCallAttempt, txHash: string) {
	if (!hash(txHash)) throw new Error('Paste the HyperEVM transaction hash from MetaMask Activity.');
	if (getBackendSession()?.identity.address !== order.sender) throw new Error('Reconnect the original TBC wallet to save this transaction hash.');
	return validateBridgeCall(await backendData(callPath(order.id, row.id, 'submit'), { txHash }, true), order, settlement);
}
export async function cancelCall(order: BridgeOrder, settlement: BridgeSettlement, row: BridgeCallAttempt, rejected = false) { return validateBridgeCall(await backendData(callPath(order.id, row.id, 'cancel'), { rejected }, true), order, settlement); }
export async function checkCall(order: BridgeOrder, row: BridgeCallAttempt, signal: AbortSignal) { return validateSettlement(await backendData(callPath(order.id, row.id, 'check'), {}, true, signal), order); }

// Public recovery pointers only. Never persist wallet approvals or private data.
const memory = new Map<string, Record<string, string>>();
export function savedCallHashes(order: BridgeOrder): Record<string, string> {
	const key = `${order.sender}:${order.id}`;
	try {
		const parsed: unknown = JSON.parse(sessionStorage.getItem(`bridge-call-receipts:${key}`) ?? '{}');
		if (isObject(parsed)) return { ...Object.fromEntries(Object.entries(parsed).filter(([id, value]) => uuid(id) && hash(value)).slice(0, 20)), ...memory.get(key) } as Record<string, string>;
	} catch { /* Activity recovery is available if browser storage is disabled. */ }
	return memory.get(key) ?? {};
}
export function rememberCallHash(order: BridgeOrder, id: string, txHash: string | null) {
	const key = `${order.sender}:${order.id}`; const saved = { ...savedCallHashes(order) };
	if (txHash) saved[id] = txHash; else delete saved[id];
	memory.set(key, saved); try { sessionStorage.setItem(`bridge-call-receipts:${key}`, JSON.stringify(saved)); } catch { /* Keep the in-memory public hash. */ }
}
