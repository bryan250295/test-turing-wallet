import type { BridgeReconciliation, ReconciliationBalanceCheck } from '../../../shared/src/types/bridgeReconciliation';
import { validWrappedName, validWrappedSymbol } from '../../../shared/src/config/bridgeRoutes';
import { backendData } from './backendClient';
import { isObject } from './apiValidation';

const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const address = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const tbcAddress = (value: unknown) => typeof value === 'string' && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(value);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const unsigned = (value: unknown) => typeof value === 'string' && /^(0|[1-9]\d{0,80})$/.test(value);
const integer = (value: unknown) => typeof value === 'string' && /^(0|-?[1-9]\d{0,80})$/.test(value);
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 1000;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optional = (check: (value: unknown) => boolean, value: unknown) => value === null || check(value);
const list = (value: unknown, check: (value: unknown) => boolean, maximum = 200) => Array.isArray(value) && value.length <= maximum && value.every(check);
function transaction(value: unknown): boolean {
	if (!isObject(value) || !text(value.id) || !text(value.label) || !['tbc', 'hyperevm'].includes(String(value.network))
		|| !text(value.status) || !optional(count, value.confirmations) || !count(value.required) || !optional(unsigned, value.actualFeeRaw) || !optional(date, value.checkedAt)) return false;
	return value.hash === null || typeof value.hash === 'string' && (value.network === 'tbc' ? /^[0-9a-f]{64}$/i : /^0x[0-9a-f]{64}$/i).test(value.hash);
}
function redemption(value: unknown): boolean {
	return isObject(value) && uuid(value.id) && date(value.createdAt) && optional(date, value.checkedAt) && unsigned(value.amountRaw) && tbcAddress(value.recipient) && address(value.escrowAddress) && text(value.status)
		&& optional(unsigned, value.fundingRaw) && optional(unsigned, value.plannedReleaseFeeRaw) && optional(unsigned, value.plannedNativeChangeRaw) && list(value.transactions, transaction, 203);
}
function order(value: unknown): boolean {
	return isObject(value) && uuid(value.id) && unsigned(value.amountRaw) && address(value.recipient) && date(value.createdAt) && text(value.status)
		&& optional(date, value.checkedAt) && list(value.transactions, transaction, 203) && list(value.redemptions, redemption);
}
function route(value: unknown): boolean {
	if (!isObject(value) || !uuid(value.deploymentId) || !address(value.wrappedToken) || typeof value.contractId !== 'string' || !/^[0-9a-f]{64}$/.test(value.contractId) || typeof value.decimals !== 'number' || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255
		||  !text(value.symbol) || !validWrappedName(value.wrappedName) || !validWrappedSymbol(value.wrappedSymbol) || !['empty', 'balanced', 'pending', 'needs_review'].includes(String(value.status)) || !list(value.issues, text)
		|| !list(value.setupTransactions, transaction, 201) || !list(value.orders, order) || !isObject(value.totals)) return false;
	const totals = value.totals;
	if (!['depositedRaw', 'mintedRaw', 'lockedRaw', 'returnedRaw', 'tbcFeesRaw', 'hypeFeesWei'].every((key) => unsigned(totals[key]))
		|| !['reserveRaw', 'circulatingRaw', 'differenceRaw'].every((key) => integer(totals[key]))) return false;
	return BigInt(String(totals.depositedRaw)) - BigInt(String(totals.returnedRaw)) === BigInt(String(totals.reserveRaw))
		&& BigInt(String(totals.mintedRaw)) - BigInt(String(totals.lockedRaw)) === BigInt(String(totals.circulatingRaw))
		&& BigInt(String(totals.reserveRaw)) - BigInt(String(totals.circulatingRaw)) === BigInt(String(totals.differenceRaw));
}
export async function loadBridgeReconciliation(expectedAddress: string, signal: AbortSignal): Promise<BridgeReconciliation> {
	const value: unknown = await backendData('/api/bridge/reconciliation', undefined, true, signal);
	if (!isObject(value) || value.identityAddress !== expectedAddress || !date(value.generatedAt) || value.basis !== 'saved_verification' || !list(value.routes, route)) {
		throw new Error('The reconciliation response is invalid or belongs to a different wallet. Reconnect and refresh.');
	}
	return value as unknown as BridgeReconciliation;
}
export async function checkReconciliationBalances(deploymentId: string, wrappedToken: string, signal: AbortSignal): Promise<ReconciliationBalanceCheck> {
	if (!uuid(deploymentId)) throw new Error('Invalid wrapped deployment.');
	const value: unknown = await backendData(`/api/bridge/reconciliation/${deploymentId}/balances`, undefined, true, signal);
	if (!isObject(value) || value.deploymentId !== deploymentId || value.wrappedToken !== wrappedToken || !date(value.startedAt) || !date(value.checkedAt)
		|| !['matching', 'difference', 'unavailable'].includes(String(value.status)) || !text(value.message) || !count(value.custodyAddressCount) || !count(value.escrowCount)) throw new Error('The balance response is invalid.');
	const fields = ['indexedReserveRaw', 'totalSupplyRaw', 'permanentlyLockedRaw', 'circulatingRaw'];
	if (value.status === 'unavailable') {
		if (![...fields, 'differenceRaw', 'targetBlockNumber', 'targetBlockHash'].every((key) => value[key] === null)) throw new Error('Unavailable balances must not contain amounts.');
	} else {
		if (!fields.every((key) => unsigned(value[key])) || !integer(value.differenceRaw) || !unsigned(value.targetBlockNumber)
			|| typeof value.targetBlockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value.targetBlockHash)
			|| BigInt(String(value.totalSupplyRaw)) - BigInt(String(value.permanentlyLockedRaw)) !== BigInt(String(value.circulatingRaw))
			|| BigInt(String(value.indexedReserveRaw)) - BigInt(String(value.circulatingRaw)) !== BigInt(String(value.differenceRaw))
			|| (value.status === 'matching') !== (value.differenceRaw === '0')) throw new Error('The balance amounts do not reconcile.');
	}
	return value as unknown as ReconciliationBalanceCheck;
}
