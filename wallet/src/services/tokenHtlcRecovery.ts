import type { HtlcInspectionResult, TokenHtlcLock, UnsignedTokenHtlc } from '../types/htlc';
import { API_URLS } from '../config/constants';
import { postHtlcData } from './unsignedTokenHtlc';
import { rememberHtlcInspection } from './htlcInspectionState';
import { isObject } from './apiValidation';
import { parseHtlcRequest } from '../utils/htlcRequestHistory';
import { migrateSavedHtlcHistory } from './htlcRequestHistory';

let inspectionQueue: Promise<unknown> = Promise.resolve();

export function inspectTokenHtlc(lockTxid: string, contractId: string, signal: AbortSignal, recoveryTxids: string[] = []): Promise<TokenHtlcLock> {
	const operation = inspectionQueue.then(async () => {
		signal.throwIfAborted();
		const lock = await readTokenHtlc(lockTxid, contractId, signal, recoveryTxids);
		signal.throwIfAborted();
		rememberHtlcInspection(lockTxid, lock);
		return lock;
	});
	inspectionQueue = operation.catch(() => undefined);
	return operation;
}

async function readTokenHtlc(lockTxid: string, contractId: string, signal: AbortSignal, recoveryTxids: string[]): Promise<TokenHtlcLock> {
	const result = await postHtlcData(API_URLS.inspectTokenHtlc, { lockTxid, contractId, recoveryTxids }, signal);
	return parseInspectedLock(result, lockTxid, contractId);
}

function parseInspectedLock(result: unknown, lockTxid: string, contractId: string): TokenHtlcLock {
	const validFee = (value: unknown) => value === undefined || typeof value === 'string' && /^\d{1,100}$/.test(value);
	if (isObject(result) && (!validFee(result.feeRaw) || isObject(result.recovery) && !validFee(result.recovery.feeRaw))) throw new Error('Invalid transaction fee response.');
	if (!isObject(result) || typeof result.chainMedianTime !== 'number' || !Number.isSafeInteger(result.chainMedianTime) || result.chainMedianTime < 500_000_000 || typeof result.refundTimestamp !== 'number' || !Number.isSafeInteger(result.refundTimestamp) || result.refundTimestamp < 500_000_000 || typeof result.refundEligible !== 'boolean' || result.refundEligible !== (result.chainMedianTime > result.refundTimestamp)) throw new Error('Invalid Testnet refund eligibility response.');
	if (result.lockTxid !== lockTxid || result.contractId !== contractId || typeof result.hashHex !== 'string' || !/^[0-9a-f]{64}$/i.test(result.hashHex) || typeof result.amountRaw !== 'string' || !/^\d+$/.test(result.amountRaw) || typeof result.decimals !== 'number' || !Number.isInteger(result.decimals) || result.decimals < 0 || result.decimals > 255 || typeof result.sender !== 'string' || typeof result.receiver !== 'string' || typeof result.controlUnspent !== 'boolean' || typeof result.tokenUnspent !== 'boolean' || typeof result.name !== 'string' || typeof result.symbol !== 'string' || typeof result.checkedAt !== 'string' || !Number.isFinite(Date.parse(result.checkedAt)) || typeof result.confirmations !== 'number' || !Number.isSafeInteger(result.confirmations) || result.confirmations < 0) throw new Error('Invalid on-chain lock response.');
	if (result.recovery && (!isObject(result.recovery) || typeof result.recovery.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(result.recovery.txid) || !['claim', 'refund'].includes(String(result.recovery.action)) || typeof result.recovery.confirmations !== 'number' || !Number.isSafeInteger(result.recovery.confirmations) || result.recovery.confirmations < 0)) throw new Error('Invalid recovery status response.');
	return result as unknown as TokenHtlcLock;
}

export function inspectWalletHtlcs(address: string, signal: AbortSignal, cursor?: string) {
	const operation = inspectionQueue.then(async () => {
		await migrateSavedHtlcHistory();
		signal.throwIfAborted();
		const response = await postHtlcData(API_URLS.htlcWalletStatus, { address, ...(cursor ? { cursor } : {}) }, signal);
		if (!isObject(response) || response.address !== address || !Array.isArray(response.requests) || !Array.isArray(response.results) || response.requests.length !== response.results.length || !(response.nextCursor === null || typeof response.nextCursor === 'string' && /^[0-9a-f]{64}$/.test(response.nextCursor) && response.nextCursor > (cursor ?? ''))) throw new Error('Invalid wallet status response.');
		const requests = response.requests.map(parseHtlcRequest);
		if (requests.some((item) => item.sender !== address && item.receiver !== address)) throw new Error('Wallet status address mismatch.');
		const expected = new Map(requests.map((item) => [item.lockTxid, item.contractId]));
		if (expected.size !== requests.length) throw new Error('Duplicate wallet status record.');
		const results = response.results.map((entry: unknown): HtlcInspectionResult => {
			if (!isObject(entry) || typeof entry.lockTxid !== 'string' || typeof entry.contractId !== 'string' || expected.get(entry.lockTxid) !== entry.contractId) throw new Error('Status result does not match the saved locks.');
			expected.delete(entry.lockTxid);
			if (typeof entry.error === 'string' && entry.lock === undefined) return { lockTxid: entry.lockTxid, contractId: entry.contractId, error: entry.error };
			if (entry.error !== undefined) throw new Error('Invalid wallet status result.');
			const lock = parseInspectedLock(entry.lock, entry.lockTxid, entry.contractId);
			if (lock.sender !== address && lock.receiver !== address) throw new Error('Inspected lock wallet mismatch.');
			return { lockTxid: entry.lockTxid, contractId: entry.contractId, lock };
		});
		if (response.nextCursor && response.nextCursor !== requests.at(-1)?.lockTxid) throw new Error('Invalid wallet status cursor.');
		return { requests, results, nextCursor: response.nextCursor as string | null };
	});
	inspectionQueue = operation.catch(() => undefined);
	return operation;
}

export async function buildTokenHtlcRecovery(lockTxid: string, contractId: string, action: 'claim' | 'refund', signal: AbortSignal): Promise<UnsignedTokenHtlc> {
	const result = await postHtlcData(API_URLS.settleTokenHtlc, { lockTxid, contractId, action }, signal);
	if (!result || result.action !== action || result.lockTxid !== lockTxid || result.network !== 'testnet' || !/^(?:[0-9a-f]{2})+$/i.test(result.rawHex) || !result.buildId || !result.signerAddress || !Array.isArray(result.inputs) || result.inputs.length !== 3 || !Array.isArray(result.outputs) || !result.plan) throw new Error('Invalid recovery transaction response.');
	return result as UnsignedTokenHtlc;
}
