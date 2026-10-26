import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WalletSession } from '../types/wallet';
import type { HtlcRequest } from '../services/htlcRequestHistory';
import { getHtlcHistorySnapshot, rememberInspectedLock, rememberSavedHtlcRequests, subscribeHtlcHistory } from '../services/htlcRequestHistory';
import { inspectTokenHtlc, inspectWalletHtlcs } from '../services/tokenHtlcRecovery';
import { getErrorMessage } from '../utils/errors';
import { ApiError } from '../services/apiClient';
import { getHtlcInspections, subscribeHtlcInspections, rememberHtlcInspection } from '../services/htlcInspectionState';

export default function useHtlcRequests(session: WalletSession, active: boolean) {
	const history = useSyncExternalStore(subscribeHtlcHistory, getHtlcHistorySnapshot);
	const observations = useSyncExternalStore(subscribeHtlcInspections, getHtlcInspections);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const request = useRef<AbortController | null>(null);
	const ready = session.wallet.isReady && !!session.address && session.networkIsDevnet;
	const requests = ready ? history.requests.filter((item) => item.sender === session.address || item.receiver === session.address).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];

	useEffect(() => {
		request.current?.abort();
		request.current = null;
		setLoading(false);
		setError('');
		return () => request.current?.abort();
	}, [session.address, session.networkIsDevnet, session.wallet.isReady, active]);

	useEffect(() => {
		if (active && ready) void refresh();
	}, [active, ready, session.address]);

	async function run(operation: (signal: AbortSignal) => Promise<void>) {
		if (!ready || request.current) return;
		const controller = new AbortController();
		request.current = controller;
		setLoading(true);
		setError('');
		try { await operation(controller.signal); }
		catch (cause) { if (!controller.signal.aborted) setError(getErrorMessage(cause)); }
		finally {
			if (request.current === controller) { request.current = null; setLoading(false); }
		}
	}

	async function inspect(lockTxid: string, contractId: string, signal: AbortSignal, candidates: HtlcRequest['recoveries'] = []) {
		const lock = await inspectTokenHtlc(lockTxid, contractId, signal, candidates.map((item) => item.txid).reverse());
		signal.throwIfAborted();
		if (lock.sender !== session.address && lock.receiver !== session.address) throw new Error('This lock does not involve the connected wallet. Switch to account A or B to add it.');
		await rememberInspectedLock(lock);
		signal.throwIfAborted();
	}

	function add(lockTxid: string, contractId: string, candidates: HtlcRequest['recoveries'] = []) {
		return run((signal) => inspect(lockTxid.trim().toLowerCase(), contractId.trim().toLowerCase(), signal, candidates));
	}

	function refresh() {
		return run(async (signal) => {
			try {
				let cursor: string | undefined;
				do {
					// The server owns discovery and pagination; no lock list is sent.
					const page = await inspectWalletHtlcs(session.address, signal, cursor);
					signal.throwIfAborted();
					rememberSavedHtlcRequests(page.requests);
					for (const result of page.results) {
						if (result.lock) {
							await rememberInspectedLock(result.lock);
							signal.throwIfAborted();
							rememberHtlcInspection(result.lockTxid, result.lock);
						} else rememberHtlcInspection(result.lockTxid, undefined, result.error);
					}
					if (page.results.some((result) => result.error)) {
						setError('Some locks could not be checked. Successful results are shown. Use Refresh requests to retry later.');
						return;
					}
					cursor = page.nextCursor ?? undefined;
				} while (cursor);
			} catch (cause) {
				signal.throwIfAborted();
				if (cause instanceof ApiError && cause.status === 429) throw new Error('Status checking stopped because the service queue is full. Try again later. No automatic retry was made.');
				throw cause;
			}
		});
	}

	return { requests, observations, loading, error, storageError: history.error, ready, add, refresh };
}
