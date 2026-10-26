import type { TokenHtlcBroadcast, TokenHtlcLock, UnsignedTokenHtlc } from '../types/htlc';
import type { HtlcRequest } from '../utils/htlcRequestHistory';
import { mergeHtlcRequest, parseHtlcRequest, requestFromLock, requestFromTransaction } from '../utils/htlcRequestHistory';
import { API_URLS } from '../config/constants';
import { postHtlcData } from './unsignedTokenHtlc';
export type { HtlcRequest } from '../utils/htlcRequestHistory';

const legacyStorageKey = 'tbc-testnet-htlc-requests-v1';
const listeners = new Set<() => void>();
const loads = new Map<string, Promise<void>>();
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
		publish(undefined, 'Could not save this request to wallet/storage. Keep your receipt, check the local server and folder permissions, then reload saved history.');
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
		for (const value of values) await persist(parseHtlcRequest(value));
		try { localStorage.removeItem(legacyStorageKey); } catch { /* Reimporting is idempotent. */ }
	})();
	try { await migration; }
	catch (cause) { migration = undefined; throw cause; }
}

export async function migrateSavedHtlcHistory() {
	try { await migrateBrowserHistory(); }
	catch { publish(undefined, 'Old browser history could not be migrated. It is still retained; saved server requests remain available.'); }
}

export function loadHtlcHistory(address: string): Promise<void> {
	const pending = loads.get(address);
	if (pending) return pending;
	const operation = (async () => {
		try {
			await writes;
			let migrationError = '';
			try { await migrateBrowserHistory(); }
			catch { migrationError = 'Old browser history could not be migrated. It is still retained in your browser; server history is available below.'; }
			const response = await fetch(`${API_URLS.htlcHistory}?address=${encodeURIComponent(address)}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
			if (!response.ok || !(response.headers.get('Content-Type') ?? '').includes('application/json')) throw new Error('History server unavailable.');
			const body: unknown = await response.json();
			if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) throw new Error('Invalid history response.');
			const requests = body.data.map(parseHtlcRequest);
			if (requests.some((item) => item.sender !== address && item.receiver !== address)) throw new Error('History wallet mismatch.');
			// Merge after pending writes, retaining entries learned while GET was running.
			const merged = new Map(snapshot.requests.map((item) => [item.lockTxid, item]));
			for (const item of requests) {
				const existing = merged.get(item.lockTxid);
				merged.set(item.lockTxid, existing && existing.updatedAt > item.updatedAt ? existing : item);
			}
			snapshot = { requests: [...merged.values()], error: migrationError };
			listeners.forEach((notify) => notify());
		} catch {
			publish(undefined, 'Saved HTLC history could not be loaded from wallet/storage. Restart the local server and retry. Any old browser history is retained until migration succeeds.');
		} finally { loads.delete(address); }
	})();
	loads.set(address, operation);
	return operation;
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
