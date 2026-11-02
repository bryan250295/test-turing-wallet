import type { TokenHtlcBroadcast, TokenHtlcLock, UnsignedTokenHtlc } from '../types/htlc';
import type { HtlcRequest } from '../utils/htlcRequestHistory';
import { mergeHtlcRequest, parseHtlcRequest, requestFromLock, requestFromTransaction } from '../utils/htlcRequestHistory';
import { API_URLS } from '../config/constants';
import { postHtlcData } from './unsignedTokenHtlc';
import { getBackendSession } from './backendClient';
export type { HtlcRequest } from '../utils/htlcRequestHistory';

const legacyStorageKey = 'tbc-testnet-htlc-requests-v1';
const listeners = new Set<() => void>();
let snapshot: { requests: HtlcRequest[]; error: string } = { requests: [], error: '' };
let writes: Promise<unknown> = Promise.resolve();
let migration: Promise<void> | undefined;

function publish(request?: HtlcRequest, error = '') {
	const requests = request
		? [request, ...snapshot.requests.filter((item) => item.lockTxid !== request.lockTxid)]
		: snapshot.requests;
	snapshot = { requests, error };
	listeners.forEach((notify) => notify());
}

export const getHtlcHistorySnapshot = () => snapshot;
export function subscribeHtlcHistory(listener: () => void) {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

async function persist(request: HtlcRequest) {
	const result = await postHtlcData(API_URLS.htlcHistory, request, new AbortController().signal);
	publish(parseHtlcRequest(result));
}

function saveRequest(request: HtlcRequest): Promise<void> {
	const operation = writes.then(() => persist(request)).catch(() => {
		publish(undefined, 'Could not save this request to the database. Keep your receipt, check the backend connection, then refresh requests.');
	});
	writes = operation;
	return operation;
}

async function migrateBrowserHistory() {
	if (migration) return migration;
	migration = (async () => {
		let raw: string | null;
		try { raw = localStorage.getItem(legacyStorageKey); }
		catch { return; } // Server storage works even when browser storage is disabled.
		if (!raw) return;
		const values: unknown = JSON.parse(raw);
		if (!Array.isArray(values) || values.length > 200) throw new Error('Invalid legacy history.');
		const address = getBackendSession()?.identity.address;
		if (!address) throw new Error('Sign in before migrating browser history.');
		const remaining: unknown[] = [];
		for (const value of values) {
			const record = parseHtlcRequest(value);
			if (record.sender === address || record.receiver === address) await persist(record);
			else remaining.push(value);
		}
		try { if (remaining.length) localStorage.setItem(legacyStorageKey, JSON.stringify(remaining)); else localStorage.removeItem(legacyStorageKey); } catch { /* Reimporting is idempotent. */ }
	})();
	try { await migration; }
	finally { migration = undefined; }
}

export async function migrateSavedHtlcHistory() {
	try { await migrateBrowserHistory(); }
	catch { publish(undefined, 'Old browser history could not be migrated. It is still retained; saved server requests remain available.'); }
}

export function rememberInspectedLock(lock: TokenHtlcLock, candidates: HtlcRequest['recoveries'] = []) {
	const next = requestFromLock(lock, candidates);
	if (candidates.length) return saveRequest(next);
	const previous = snapshot.requests.find((item) => item.lockTxid === next.lockTxid);
	publish(mergeHtlcRequest(previous, next), snapshot.error);
}

export function rememberHtlcSubmission(transaction: UnsignedTokenHtlc, txid: string, receipt?: TokenHtlcBroadcast) {
	const value = requestFromTransaction(transaction, txid, receipt);
	if (!receipt && (transaction.action ?? 'lock') === 'lock') value.submission = 'unknown';
	const previous = snapshot.requests.find((item) => item.lockTxid === value.lockTxid);
	// The broadcast handler persists independently of the browser response.
	publish(mergeHtlcRequest(previous, value), snapshot.error);
}

// Merge public records returned by the wallet status API without posting them again.
export function rememberSavedHtlcRequests(requests: HtlcRequest[]) {
	const merged = new Map(snapshot.requests.map((item) => [item.lockTxid, item]));
	for (const item of requests) merged.set(item.lockTxid, mergeHtlcRequest(merged.get(item.lockTxid), item));
	snapshot = { requests: [...merged.values()], error: '' };
	listeners.forEach((notify) => notify());
}
