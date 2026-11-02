import type { BridgeOrder, RedemptionOrder, RedemptionEscrowDeployment, RedemptionWalletCall, RedemptionWalletKind, RedemptionWalletState } from '../../../shared/src/types/learningBridge';
import { backendData, getBackendSession } from './backendClient';
import { isObject } from './apiValidation';
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x(?!0{64}$)[0-9a-f]{64}$/.test(v);
const uint = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,77})$/.test(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v);
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const kinds = ['unpause', 'reset', 'approve', 'lock'];
function path(order: BridgeOrder, row: RedemptionOrder, suffix = '') {
	if (!uuid(order.id) || !uuid(row.id) || row.orderId !== order.id) throw new Error('Invalid redemption ID.');
	return `/api/bridge/orders/${order.id}/redemption/orders/${row.id}/wallet${suffix}`;
}
function actionPath(order: BridgeOrder, row: RedemptionOrder, id: string, action: string) { if (!uuid(id)) throw new Error('Invalid wallet request ID.'); return path(order, row, `/${id}/${action}`); }
export function redemptionWalletData(row: RedemptionOrder, kind: RedemptionWalletKind) {
	const word = (v: string) => v.replace(/^0x/, '').toLowerCase().padStart(64, '0');
	if (kind === 'unpause') return '0x3f4ba83a';
	if (kind === 'reset' || kind === 'approve') return `0x095ea7b3${word(row.escrowAddress)}${BigInt(kind === 'reset' ? '0' : row.amountRaw).toString(16).padStart(64, '0')}`;
	const text = new TextEncoder().encode(row.tbcRecipient);
	const bytes = Array.from(text, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `0x2b145d57${word(row.redemptionId)}${'60'.padStart(64, '0')}${BigInt(row.amountRaw).toString(16).padStart(64, '0')}${text.length.toString(16).padStart(64, '0')}${bytes.padEnd(Math.ceil(text.length / 32) * 64, '0')}`;
}
function validate(value: unknown, row: RedemptionOrder, escrow: RedemptionEscrowDeployment): RedemptionWalletCall {
	if (!isObject(value) || !uuid(value.id) || value.redemptionId !== row.id || !kinds.includes(String(value.kind)) || !isObject(value.transaction)
		|| !['quoted', 'awaiting_wallet', 'submitted', 'confirming', 'verified', 'reverted', 'invalid', 'cancelled'].includes(String(value.status))
		|| !uint(value.estimatedFeeWei) || !uint(value.budgetWei) || !date(value.expiresAt) || !date(value.createdAt)
		|| value.txHash !== null && !hash(value.txHash) || !Number.isSafeInteger(value.confirmations) || Number(value.confirmations) < 0
		|| value.actualFeeWei !== null && !uint(value.actualFeeWei) || value.lastError !== null && typeof value.lastError !== 'string') throw new Error('Invalid saved redemption wallet request.');
	const kind = value.kind as RedemptionWalletKind; const tx = value.transaction;
	if (escrow.id !== row.escrowId || escrow.contractAddress !== row.escrowAddress || tx.from !== (kind === 'unpause' ? escrow.quote.admin : row.holder)
		|| tx.to !== (kind === 'approve' || kind === 'reset' ? row.wrappedToken : row.escrowAddress) || tx.chainId !== '0x3e6' || tx.value !== '0x0'
		|| tx.data !== redemptionWalletData(row, kind) || !hex(tx.nonce) || BigInt(tx.nonce) > BigInt(Number.MAX_SAFE_INTEGER)
		|| !hex(tx.gas) || BigInt(tx.gas) <= 0n || BigInt(tx.gas) > 50000000n || !hex(tx.gasPrice) || BigInt(tx.gasPrice) <= 0n
		|| BigInt(value.budgetWei) !== BigInt(tx.gas) * BigInt(tx.gasPrice) || BigInt(value.estimatedFeeWei) > BigInt(value.budgetWei)
		|| value.status === 'verified' && (!value.txHash || Number(value.confirmations) < 6 || value.actualFeeWei === null)) throw new Error('Wallet calldata, exact allowance, recipient, lock amount or HYPE budget differs from the reviewed redemption.');
	return value as unknown as RedemptionWalletCall;
}
export async function listRedemptionCalls(order: BridgeOrder, row: RedemptionOrder, escrow: RedemptionEscrowDeployment, signal: AbortSignal) {
	const value: unknown = await backendData(path(order, row), undefined, true, signal);
	if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid saved wallet request list.');
	return value.map((v) => validate(v, row, escrow));
}
export async function redemptionWalletState(order: BridgeOrder, row: RedemptionOrder, escrow: RedemptionEscrowDeployment, signal: AbortSignal) {
	const v: unknown = await backendData(path(order, row, '/state'), {}, true, signal);
	if (!isObject(v) || v.redemptionId !== row.id || typeof v.paused !== 'boolean' || !uint(v.allowanceRaw) || !uint(v.balanceRaw)
		|| !kinds.includes(String(v.nextKind)) || v.from !== (v.nextKind === 'unpause' ? escrow.quote.admin : row.holder) || !uint(v.blockNumber) || !hash(v.blockHash)) throw new Error('Invalid current escrow wallet state.');
	const expected = v.paused ? 'unpause' : BigInt(v.allowanceRaw) === BigInt(row.amountRaw) ? 'lock' : BigInt(v.allowanceRaw) > 0n ? 'reset' : 'approve';
	if (v.nextKind !== expected || BigInt(v.balanceRaw) < BigInt(row.amountRaw)) throw new Error('Wallet state differs from the required exact allowance or balance.');
	return v as unknown as RedemptionWalletState;
}
export async function quoteRedemptionCall(order: BridgeOrder, row: RedemptionOrder, escrow: RedemptionEscrowDeployment, kind: RedemptionWalletKind, from: string, signal: AbortSignal) {
	const value = validate(await backendData(path(order, row, '/quote'), { kind, from }, true, signal), row, escrow);
	if (value.kind !== kind || value.status !== 'quoted' || value.transaction.from !== from.toLowerCase()) throw new Error('The wallet quote differs from the requested action.');
	return value;
}
export async function redemptionCallAction(order: BridgeOrder, row: RedemptionOrder, escrow: RedemptionEscrowDeployment, call: RedemptionWalletCall, action: 'begin' | 'submit' | 'check' | 'cancel', payload: unknown, signal?: AbortSignal) {
	if (getBackendSession()?.identity.address !== order.sender) throw new Error('Reconnect the original TBC identity to save wallet progress.');
	const value = validate(await backendData(actionPath(order, row, call.id, action), payload, true, signal), row, escrow);
	if (value.id !== call.id || value.kind !== call.kind || JSON.stringify(value.transaction) !== JSON.stringify(call.transaction)) throw new Error('The saved wallet request changed its frozen transaction.');
	if (action === 'begin' && value.status !== 'awaiting_wallet') throw new Error('The wallet send slot was not reserved.');
	return value;
}
const memory = new Map<string, Record<string, string>>();
function key(row: RedemptionOrder) { return `redemption-wallet-hashes:${row.orderId}:${row.id}`; }
export function redemptionCallHashes(row: RedemptionOrder): Record<string, string> {
	try {
		const value: unknown = JSON.parse(sessionStorage.getItem(key(row)) ?? '{}');
		if (isObject(value)) {
			const saved: Record<string, string> = {};
			for (const [id, txHash] of Object.entries(value).slice(0, 20)) if (uuid(id) && hash(txHash)) saved[id] = txHash;
			return { ...saved, ...memory.get(key(row)) };
		}
	} catch { /* Keep public receipt pointers in memory if storage is unavailable. */ }
	return memory.get(key(row)) ?? {};
}
export function rememberRedemptionCallHash(row: RedemptionOrder, id: string, txHash: string | null) {
	const saved = { ...redemptionCallHashes(row) }; if (txHash) saved[id] = txHash; else delete saved[id];
	memory.set(key(row), saved); try { sessionStorage.setItem(key(row), JSON.stringify(saved)); } catch { /* Activity recovery remains available. */ }
}
