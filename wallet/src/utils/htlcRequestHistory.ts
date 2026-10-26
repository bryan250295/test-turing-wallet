import type { TokenHtlcBroadcast, TokenHtlcLock, UnsignedTokenHtlc } from '../types/htlc';
import { isObject } from '../services/apiValidation';

export interface HtlcRequest {
	lockTxid: string;
	contractId: string;
	sender: string;
	receiver: string;
	amountRaw: string;
	decimals: number;
	symbol: string;
	tokenName?: string;
	refundTimestamp: number;
	createdAt: string;
	updatedAt: string;
	submission?: TokenHtlcBroadcast['status'];
	recoveries: { txid: string; action: 'claim' | 'refund'; submission?: TokenHtlcBroadcast['status'] }[];
}

const txidPattern = /^[0-9a-f]{64}$/;
const submission = (value: unknown): HtlcRequest['submission'] => value === 'submitted' || value === 'unknown' || value === 'rejected' ? value : undefined;

export function savedHtlcStatus(request: HtlcRequest): string {
	if (request.submission === 'submitted') return 'Submitted · check confirmations';
	if (request.submission === 'rejected') return 'Submission rejected';
	if (request.submission === 'unknown') return 'Submission unverified';
	return 'Saved only · submission unverified';
}

// Reconstruct an allowlist: exports, raw transactions, signatures and secrets
// must never enter the persisted history, even when reading modified storage.
export function parseHtlcRequest(value: unknown): HtlcRequest {
	if (isObject(value) && value.tokenName !== undefined && (typeof value.tokenName !== 'string' || value.tokenName.length > 1000)) throw new Error('Invalid saved token name.');
	if (!isObject(value) || typeof value.lockTxid !== 'string' || !txidPattern.test(value.lockTxid) || typeof value.contractId !== 'string' || !txidPattern.test(value.contractId) || typeof value.sender !== 'string' || !value.sender || value.sender.length > 100 || typeof value.receiver !== 'string' || !value.receiver || value.receiver.length > 100 || typeof value.amountRaw !== 'string' || !/^\d{1,100}$/.test(value.amountRaw) || typeof value.decimals !== 'number' || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255 || typeof value.symbol !== 'string' || value.symbol.length > 100 || typeof value.refundTimestamp !== 'number' || !Number.isSafeInteger(value.refundTimestamp) || value.refundTimestamp < 500_000_000 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || !Array.isArray(value.recoveries) || value.recoveries.length > 10) throw new Error('Invalid local HTLC history.');
	const recoveries = value.recoveries.map<HtlcRequest['recoveries'][number]>((item: unknown) => {
		if (!isObject(item) || typeof item.txid !== 'string' || !txidPattern.test(item.txid) || (item.action !== 'claim' && item.action !== 'refund')) throw new Error('Invalid saved recovery.');
		return { txid: item.txid, action: item.action, submission: submission(item.submission) };
	});
	return { lockTxid: value.lockTxid, contractId: value.contractId, sender: value.sender, receiver: value.receiver, amountRaw: value.amountRaw, decimals: value.decimals, symbol: value.symbol, tokenName: typeof value.tokenName === 'string' ? value.tokenName : undefined, refundTimestamp: value.refundTimestamp, createdAt: value.createdAt, updatedAt: value.updatedAt, submission: submission(value.submission), recoveries };
}

export function requestFromLock(lock: TokenHtlcLock, candidates: HtlcRequest['recoveries'] = []): HtlcRequest {
	const timestamp = new Date().toISOString();
	const recoveries = [...new Map([...candidates, ...(lock.recovery ? [{ txid: lock.recovery.txid, action: lock.recovery.action, submission: 'submitted' as const }] : [])].map((item) => [item.txid, item])).values()].slice(-10);
	return parseHtlcRequest({ lockTxid: lock.lockTxid, contractId: lock.contractId, sender: lock.sender, receiver: lock.receiver, amountRaw: lock.amountRaw, decimals: lock.decimals, symbol: lock.symbol, tokenName: lock.name, refundTimestamp: lock.refundTimestamp, createdAt: timestamp, updatedAt: timestamp, submission: 'submitted', recoveries });
}

export function requestFromTransaction(transaction: UnsignedTokenHtlc, txid: string, receipt?: TokenHtlcBroadcast): HtlcRequest {
	const { plan, action = 'lock' } = transaction;
	const timestamp = new Date().toISOString();
	return parseHtlcRequest({ lockTxid: action === 'lock' ? txid : transaction.lockTxid ?? '', contractId: plan.terms.contractId, sender: plan.terms.sender, receiver: plan.terms.receiver, amountRaw: plan.amountRaw, decimals: plan.decimals, symbol: plan.symbol, tokenName: plan.tokenName, refundTimestamp: plan.refundTimestamp, createdAt: timestamp, updatedAt: timestamp, submission: action === 'lock' ? receipt?.status : undefined, recoveries: action === 'lock' ? [] : [{ txid, action, submission: receipt?.status }] });
}

export function mergeHtlcRequest(previous: HtlcRequest | undefined, next: HtlcRequest): HtlcRequest {
	if (previous && previous.contractId !== next.contractId) throw new Error('Conflicting lock contract.');
	const mergeStatus = (old: HtlcRequest['submission'], incoming: HtlcRequest['submission']) => old === 'submitted' ? old : incoming ?? old;
	const recoveries = new Map((previous?.recoveries ?? []).map((item) => [item.txid, item]));
	for (const item of next.recoveries) recoveries.set(item.txid, { ...item, submission: mergeStatus(recoveries.get(item.txid)?.submission, item.submission) });
	return { ...next, tokenName: next.tokenName || previous?.tokenName, createdAt: previous?.createdAt ?? next.createdAt, submission: mergeStatus(previous?.submission, next.submission), recoveries: [...recoveries.values()].slice(-10) };
}

export function htlcRequestStatus(item: HtlcRequest, lock?: TokenHtlcLock) {
	if (lock?.recovery) {
		const { action, confirmations } = lock.recovery;
		return confirmations > 0 ? (action === 'claim' ? 'Claimed' : 'Refunded') : `${action === 'claim' ? 'Claim' : 'Refund'} awaiting confirmation`;
	}
	if (lock) {
		if (!lock.controlUnspent || !lock.tokenUnspent) return 'Spent / unavailable';
		return lock.confirmations > 0 ? 'Locked' : 'Lock awaiting confirmation';
	}
	return savedHtlcStatus(item);
}

export function canRecoverHtlc(lock?: TokenHtlcLock): boolean {
	return !!lock && !lock.recovery && lock.controlUnspent && lock.tokenUnspent && lock.confirmations > 0;
}

export function isCompletedHtlc(lock?: TokenHtlcLock, error?: string): boolean {
	return !error && !!lock?.recovery && lock.recovery.confirmations > 0;
}

export function formatHtlcDate(value: string | number): string {
	const date = new Date(typeof value === 'number' ? value * 1000 : value);
	return Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB', {
		timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'medium',
	}) : 'Unavailable';
}

export function htlcActionReason(lock?: TokenHtlcLock, error?: string, action?: 'claim' | 'refund'): string {
	if (error) return 'Status could not be verified. Refresh requests before continuing.';
	if (!lock) return 'Waiting for a verified lock status.';
	if (lock.recovery) return lock.recovery.confirmations > 0 ? 'This lock is completed.' : 'A claim or refund is awaiting confirmation.';
	if (!lock.controlUnspent || !lock.tokenUnspent) return 'The lock outputs are spent or unavailable.';
	if (lock.confirmations < 1) return 'Waiting for the lock transaction to confirm.';
	if (action === 'refund' && !lock.refundEligible) return 'Refund is not yet eligible by Testnet chain time.';
	return '';
}
