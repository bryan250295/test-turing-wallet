import type { HtlcInspectionItem, HtlcInspectionResult } from '../../src/types/htlc';
import { ApiError } from '../../src/services/apiClient';
import { getErrorMessage } from '../../src/utils/errors';
import { inspectTokenHtlc, type LockReadContext } from './tokenHtlcRecovery';
import { HtlcRequestQueue, untilAborted } from './requestQueue';
import { HTLC_INSPECTION_BATCH_LIMIT } from '../../src/config/constants';
import { listStoredHtlcRequests } from './requestStorage';
import type { HtlcRequest } from '../../src/utils/htlcRequestHistory';

const hex = /^[0-9a-f]{64}$/i;
interface WalletInspection {
	address: string;
	requests: HtlcRequest[];
	results: HtlcInspectionResult[];
	nextCursor: string | null;
	total: number;
}
const recent = new Map<string, { fingerprint: string; expires: number; result: WalletInspection }>();
const pending = new Map<string, { fingerprint: string; operation: Promise<WalletInspection> }>();
const walletChecks = new HtlcRequestQueue(1, 8);

export async function inspectWallet(value: unknown, signal: AbortSignal, httpDeadline: number) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provide a wallet address.');
	const fields = value as Record<string, unknown>;
	if (Object.keys(fields).some((key) => !['address', 'cursor'].includes(key)) || typeof fields.address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{26,100}$/.test(fields.address) || fields.cursor !== undefined && (typeof fields.cursor !== 'string' || !hex.test(fields.cursor))) throw new Error('Invalid wallet address or cursor.');
	const requests = (await listStoredHtlcRequests(fields.address)).sort((a, b) => a.lockTxid.localeCompare(b.lockTxid));
	signal.throwIfAborted();
	const cursor = typeof fields.cursor === 'string' ? fields.cursor.toLowerCase() : '';
	const remaining = requests.filter((item) => item.lockTxid > cursor);
	const page = remaining.slice(0, HTLC_INSPECTION_BATCH_LIMIT);
	const address = fields.address;
	const key = `${address}:${cursor}`;
	// Ignore updatedAt: checking a lock itself updates that metadata timestamp.
	const fingerprint = JSON.stringify(requests.map((item) => [item.lockTxid, item.contractId, item.recoveries.map((entry) => [entry.txid, entry.action])]));
	const cached = recent.get(key);
	if (cached?.fingerprint === fingerprint && cached.expires > Date.now()) return cached.result;
	const running = pending.get(key);
	if (running?.fingerprint === fingerprint) return untilAborted(running.operation, signal);

	// Read-only shared work may finish after a browser leaves. Never restart it
	// for a Strict Mode remount or another tab viewing the same wallet/page.
	const jobSignal = AbortSignal.timeout(75000);
	const operation = (async (): Promise<WalletInspection> => {
		const release = await walletChecks.acquire(jobSignal);
		try {
			const batch = await inspectBatch(page.map((item) => ({ lockTxid: item.lockTxid, contractId: item.contractId, recoveryTxids: item.recoveries.map((entry) => entry.txid).reverse() })), jobSignal, httpDeadline);
			return { address, requests: page, results: batch.results, nextCursor: remaining.length > page.length ? page.at(-1)!.lockTxid : null, total: requests.length };
		} finally { release(); }
	})();
	pending.set(key, { fingerprint, operation });
	void operation.then((result) => {
		if (pending.get(key)?.operation !== operation) return;
		for (const [id, entry] of recent) if (entry.expires <= Date.now()) recent.delete(id);
		// Only public display snapshots; transaction validation never reads this cache.
		recent.delete(key);
		recent.set(key, { fingerprint, expires: Date.now() + (result.results.some((item) => item.error) ? 5000 : 15000), result });
		while (recent.size > 100) recent.delete(recent.keys().next().value!);
	}, () => undefined).finally(() => {
		if (pending.get(key)?.operation === operation) pending.delete(key);
	});
	return untilAborted(operation, signal);
}

export async function inspectBatch(items: HtlcInspectionItem[], signal: AbortSignal, httpDeadline: number) {
	const results: HtlcInspectionResult[] = [];
	const context: LockReadContext = { raw: new Map(), metadata: new Map() };
	// Return completed results before the outer HTTP deadline, even if a node stalls.
	const deadline = Math.min(Date.now() + 70000, httpDeadline - 1500);
	let stopped = '';
	for (const { lockTxid, contractId, recoveryTxids } of items) {
		signal.throwIfAborted();
		if (!stopped && Date.now() >= deadline) stopped = 'Batch time budget reached. Refresh requests to retry later.';
		if (stopped) { results.push({ lockTxid, contractId, error: stopped }); continue; }
		const itemSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(20000, deadline - Date.now())))]);
		try {
			const lock = await untilAborted(inspectTokenHtlc(lockTxid, contractId, itemSignal, recoveryTxids, context), itemSignal);
			results.push({ lockTxid, contractId, lock });
		} catch (cause) {
			signal.throwIfAborted();
			results.push({ lockTxid, contractId, error: itemSignal.aborted ? 'This lock check timed out. Refresh requests to retry later.' : getErrorMessage(cause) });
			if (cause instanceof ApiError && cause.status === 429) stopped = 'Testnet rate limit reached. Remaining locks were not queried. Try again later.';
		}
	}
	return { results };
}
