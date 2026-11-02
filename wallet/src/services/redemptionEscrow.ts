import type { BridgeOrder, BridgeDeploymentTransaction, RedemptionEscrowDeployment, RedemptionEscrowPreview } from '../../../shared/src/types/learningBridge';
import { LEARNING_REDEMPTION_ESCROW_BUILD as build } from '../../../shared/src/contracts/learningRedemptionEscrow';
import { backendData, getBackendSession } from './backendClient';
import { isObject } from './apiValidation';

const unsigned = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function validateEscrowPreview(value: unknown, order: BridgeOrder, admin: string): RedemptionEscrowPreview {
	if (!/^0x[0-9a-f]{40}$/i.test(admin)) throw new Error('Invalid escrow preview account.');
	if (!isObject(value) || value.orderId !== order.id || value.chainId !== 998 || value.wrappedToken !== order.destinationContract
		|| value.admin !== admin.toLowerCase() || value.sourceContractId !== order.contractId || value.decimals !== order.decimals
		|| value.reserveAmountRaw !== order.amountRaw || !Number.isSafeInteger(value.reserveConfirmations) || Number(value.reserveConfirmations) < order.sourceConfirmationsRequired
		|| !date(value.reserveCheckedAt) || !unsigned(value.wrappedBalanceRaw) || !unsigned(value.nonce) || BigInt(value.nonce) > BigInt(Number.MAX_SAFE_INTEGER)
		|| !unsigned(value.gasEstimate) || !unsigned(value.gasLimit) || !unsigned(value.gasPriceWei) || !unsigned(value.estimatedFeeWei) || !unsigned(value.budgetWei) || !unsigned(value.balanceWei)
		|| BigInt(value.gasEstimate) <= 0n || BigInt(value.gasLimit) > 50_000_000n || BigInt(value.gasPriceWei) <= 0n
		|| BigInt(value.gasLimit) !== (BigInt(value.gasEstimate) * 120n + 99n) / 100n
		|| BigInt(value.estimatedFeeWei) !== BigInt(value.gasEstimate) * BigInt(value.gasPriceWei)
		|| BigInt(value.budgetWei) !== BigInt(value.gasLimit) * BigInt(value.gasPriceWei)
		|| value.sufficientBalance !== (BigInt(value.balanceWei) >= BigInt(value.budgetWei))
		|| value.buildInputSha256 !== build.buildInputSha256 || typeof value.initCodeHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(value.initCodeHash)
		|| !date(value.quotedAt) || !date(value.expiresAt) || Date.parse(value.expiresAt) - Date.parse(value.quotedAt) !== 60_000
		|| value.lockingEnabled !== false || value.sourceReleaseEnabled !== false) throw new Error('The escrow preview differs from the completed order or approved build.');
	const word = (address: string) => address.slice(2).toLowerCase().padStart(64, '0');
	const expected = `${build.bytecode}${word(order.destinationContract)}${word(admin)}${order.contractId}${BigInt(order.decimals).toString(16).padStart(64, '0')}`;
	if (value.transactionData !== expected) throw new Error('The escrow constructor differs from the reviewed token, admin or source FT.');
	return value as unknown as RedemptionEscrowPreview;
}

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x(?!0{64}$)[0-9a-f]{64}$/.test(value);
const address = (value: unknown) => typeof value === 'string' && /^0x(?!0{40}$)[0-9a-f]{40}$/.test(value);
function path(order: BridgeOrder, suffix: string) {
	if (!uuid(order.id)) throw new Error('Invalid bridge order ID.');
	return `/api/bridge/orders/${order.id}/redemption/${suffix}`;
}
function action(order: BridgeOrder, id: string, suffix: string) { if (!uuid(id)) throw new Error('Invalid escrow deployment ID.'); return path(order, `deployments/${id}/${suffix}`); }
function validateDeployment(value: unknown, order: BridgeOrder): RedemptionEscrowDeployment {
	if (!isObject(value) || !uuid(value.id) || value.orderId !== order.id || value.deploymentId !== order.deploymentId
		|| !['prepared', 'awaiting_wallet', 'submitted', 'confirming', 'verified', 'cancelled', 'reverted', 'invalid'].includes(String(value.status))
		|| !isObject(value.quote) || typeof value.quote.admin !== 'string'
		|| value.txHash !== null && !hash(value.txHash) || value.contractAddress !== null && !address(value.contractAddress)
		|| !Number.isSafeInteger(value.confirmations) || Number(value.confirmations) < 0 || value.requiredConfirmations !== 6
		|| value.receiptBlockHash !== null && !hash(value.receiptBlockHash) || value.receiptBlockNumber !== null && !unsigned(value.receiptBlockNumber)
		|| value.actualFeeWei !== null && !unsigned(value.actualFeeWei) || value.runtimeCodeHash !== null && !hash(value.runtimeCodeHash)
		|| value.verifiedAt !== null && !date(value.verifiedAt) || value.checkedAt !== null && !date(value.checkedAt)
		|| value.lastError !== null && typeof value.lastError !== 'string' || !date(value.createdAt)) throw new Error('Invalid escrow deployment record. Refresh saved escrows.');
	validateEscrowPreview(value.quote, order, value.quote.admin);
	if (value.status === 'verified' && (!value.txHash || !value.contractAddress || !value.receiptBlockHash || value.receiptBlockNumber === null || !value.runtimeCodeHash || !value.verifiedAt || value.actualFeeWei === null || Number(value.confirmations) < 6)) throw new Error('Escrow verification evidence is incomplete.');
	return value as unknown as RedemptionEscrowDeployment;
}
export async function listEscrows(order: BridgeOrder, signal: AbortSignal) {
	const rows: unknown = await backendData(path(order, 'deployments'), undefined, true, signal);
	if (!Array.isArray(rows) || rows.length > 20) throw new Error('Invalid escrow history response.');
	return rows.map((row) => validateDeployment(row, order));
}
export async function prepareEscrow(order: BridgeOrder, admin: string, signal: AbortSignal) {
	return validateDeployment(await backendData(path(order, 'deployments'), { from: admin }, true, signal), order);
}
export async function beginEscrow(order: BridgeOrder, row: RedemptionEscrowDeployment, signal: AbortSignal) {
	const next = validateDeployment(await backendData(action(order, row.id, 'begin'), {}, true, signal), order);
	if (next.status !== 'awaiting_wallet' || JSON.stringify(next.quote) !== JSON.stringify(row.quote)) throw new Error('The escrow send authorization differs from the reviewed quote. Refresh saved escrows.');
	return next;
}
export async function cancelEscrow(order: BridgeOrder, row: RedemptionEscrowDeployment, notSent = false) {
	return validateDeployment(await backendData(action(order, row.id, 'cancel'), { notSent }, true), order);
}
export async function checkEscrow(order: BridgeOrder, row: RedemptionEscrowDeployment, signal: AbortSignal) {
	return validateDeployment(await backendData(action(order, row.id, 'check'), {}, true, signal), order);
}
export async function submitEscrow(order: BridgeOrder, row: RedemptionEscrowDeployment, txHash: string) {
	if (!hash(txHash)) throw new Error('Paste the escrow creation hash from MetaMask Activity.');
	if (getBackendSession()?.identity.address !== order.sender) throw new Error('Reconnect the original TBC wallet to save this escrow transaction hash.');
	return validateDeployment(await backendData(action(order, row.id, 'submit'), { txHash }, true), order);
}
export function escrowTransaction(row: RedemptionEscrowDeployment): BridgeDeploymentTransaction {
	const quote = row.quote;
	return { from: quote.admin, chainId: '0x3e6', value: '0x0', data: quote.transactionData,
		gas: `0x${BigInt(quote.gasLimit).toString(16)}`, gasPrice: `0x${BigInt(quote.gasPriceWei).toString(16)}`, nonce: `0x${BigInt(quote.nonce).toString(16)}` };
}

// Only public receipt pointers are stored here, never approvals or private keys.
const memory = new Map<string, Record<string, string>>();
export function escrowHashes(order: BridgeOrder): Record<string, string> {
	const key = `${order.sender}:${order.id}`;
	try {
		const value: unknown = JSON.parse(sessionStorage.getItem(`escrow-deployment-hashes:${key}`) ?? '{}');
		if (isObject(value)) return { ...Object.fromEntries(Object.entries(value).filter(([id, txHash]) => uuid(id) && hash(txHash)).slice(0, 20)), ...memory.get(key) } as Record<string, string>;
	} catch { /* Activity recovery remains available if storage is disabled. */ }
	return memory.get(key) ?? {};
}
export function rememberEscrowHash(order: BridgeOrder, id: string, txHash: string | null) {
	const key = `${order.sender}:${order.id}`; const saved = { ...escrowHashes(order) };
	if (txHash) saved[id] = txHash; else delete saved[id];
	memory.set(key, saved); try { sessionStorage.setItem(`escrow-deployment-hashes:${key}`, JSON.stringify(saved)); } catch { /* Keep the public hash in memory. */ }
}
