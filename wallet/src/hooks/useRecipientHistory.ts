import { useEffect, useState, useSyncExternalStore } from 'react';
import { getTokenHistory, getTokenTransaction } from '../services/tbcApi';
import { rememberRecipients } from '../services/recipientCache';
import { backendData, getBackendSession, subscribeBackendSession } from '../services/backendClient';
import { API_URLS } from '../config/constants';
import { getHtlcHistorySnapshot, subscribeHtlcHistory, rememberSavedHtlcRequests } from '../services/htlcRequestHistory';
import { parseHtlcRequest } from '../utils/htlcRequestHistory';
import type { TransactionData } from '../types/api';

const isConfirmed = (data: TransactionData) => data.height !== -1 && (Number.isSafeInteger(data.confirmations) && (data.confirmations ?? 0) > 0 || data.confirmations === undefined && Number.isSafeInteger(data.height) && (data.height ?? 0) > 0);
const hasParties = (data: TransactionData) => (data.input ?? data.vin)?.length && (data.output ?? data.vout)?.length;
function outgoingRecipients(data: TransactionData, owner: string) {
	const inputs = data.input ?? data.vin ?? [];
	const outputs = data.output ?? data.vout ?? [];
	// Require FT input ownership, rather than inferring direction from native fee inputs.
	if (!inputs.some((input) => input.address === owner)) return [];
	return outputs.flatMap((output) => {
		const value = output.balance ?? output.value;
		if (typeof value === 'number' && !Number.isSafeInteger(value)) return [];
		return typeof output.address === 'string' && /^\d+$/.test(String(value)) && BigInt(value!) > 0n ? [output.address] : [];
	});
}

export default function useRecipientHistory(owner: string) {
	const session = useSyncExternalStore(subscribeBackendSession, getBackendSession);
	const locks = useSyncExternalStore(subscribeHtlcHistory, getHtlcHistorySnapshot);
	const authenticated = Boolean(owner && session?.identity.address === owner && session.identity.chain === 'tbc' && session.identity.network === 'testnet');
	const [lockError, setLockError] = useState({ owner: '', error: '' });
	const [locksLoading, setLocksLoading] = useState('');

	// Reuse server-backed HTLC history, including records created before this address book existed.
	useEffect(() => {
		if (!owner) return;
		const recipients = locks.requests.filter((item) => item.sender === owner && item.submission === 'submitted')
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => item.receiver);
		rememberRecipients(owner, recipients);
	}, [owner, locks]);

	useEffect(() => {
		if (!authenticated) return;
		const controller = new AbortController();
		setLocksLoading(owner);
		setLockError({ owner, error: '' });
		void (async () => {
			try {
				const values: unknown = await backendData(`${API_URLS.htlcHistory}?address=${encodeURIComponent(owner)}`, undefined, true, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]));
				if (!Array.isArray(values)) throw new Error('Invalid saved lock history.');
				const requests = values.map(parseHtlcRequest);
				if (requests.some((item) => item.sender !== owner && item.receiver !== owner)) throw new Error('Wallet history identity mismatch.');
				controller.signal.throwIfAborted();
				rememberSavedHtlcRequests(requests);
			} catch {
				if (!controller.signal.aborted) setLockError({ owner, error: 'Saved recipient history is unavailable. You can still enter an address.' });
			} finally {
				if (!controller.signal.aborted) setLocksLoading('');
			}
		})();
		return () => controller.abort();
	}, [owner, authenticated]);
	const [state, setState] = useState({ owner: '', loading: false, error: '' });
	useEffect(() => {
		if (!owner) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		const resolved = new Map<string, string[]>();
		async function refresh() {
			setState({ owner, loading: true, error: '' });
			try {
				const history = await getTokenHistory(owner, { signal: controller.signal });
				const confirmed = history.filter(isConfirmed).sort((a, b) => (b.time ?? 0) - (a.time ?? 0) || (b.height ?? 0) - (a.height ?? 0));
				const recipients: string[] = [];
				let incomplete = false;
				// Bound detail lookups; older records with complete parties can still contribute.
				let lookups = 0;
				for (const record of confirmed) {
					controller.signal.throwIfAborted();
					const cached = resolved.get(record.txid);
					if (cached) {
						recipients.push(...cached);
						if (new Set(recipients).size >= 100) break;
						continue;
					}
					let data: TransactionData = record;
					if (!hasParties(data)) {
						if (lookups++ >= 100) { incomplete = true; continue; }
						try {
							data = await getTokenTransaction(record.txid, { signal: controller.signal });
							if (!isConfirmed(data)) continue;
						} catch { incomplete = true; continue; }
					}
					if (!hasParties(data)) { incomplete = true; continue; }
					const addresses = outgoingRecipients(data, owner);
					if (resolved.size < 1000) resolved.set(record.txid, addresses);
					recipients.push(...addresses);
					if (new Set(recipients).size >= 100) break;
				}
				controller.signal.throwIfAborted();
				rememberRecipients(owner, recipients);
				setState({ owner, loading: false, error: incomplete ? 'Some recipient history is unavailable. You can still enter an address.' : '' });
			} catch {
				if (!controller.signal.aborted) setState({ owner, loading: false, error: 'Recipient history is unavailable. You can still choose a saved recipient or enter an address.' });
			} finally {
				if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 60_000);
			}
		}
		void refresh();
		return () => { controller.abort(); clearTimeout(timer); };
	}, [owner]);
	return { loading: Boolean(owner) && (authenticated && locksLoading === owner || state.owner === owner && state.loading), error: [state.owner === owner ? state.error : '', lockError.owner === owner && authenticated ? lockError.error : ''].filter(Boolean).join(' ') };
}
