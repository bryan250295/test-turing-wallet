import { useEffect, useRef, useState } from 'react';
import type { WalletSession } from '../types/wallet';
import { retrieveClaimSecret } from '../services/claimSecrets';
import { getErrorMessage } from '../utils/errors';

export default function useSavedClaimSecret(session: WalletSession, owner: string, lockTxid: string) {
	const [secret, setSecret] = useState('');
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const request = useRef<AbortController | null>(null);
	const pending = useRef(false);
	const ready = session.wallet.isReady && session.networkIsDevnet && session.address === owner;
	useEffect(() => {
		request.current?.abort();
		setSecret(''); setError(''); setLoading(false);
		return () => request.current?.abort();
	}, [session.address, session.networkIsDevnet, session.wallet.isReady, lockTxid, owner]);

	async function retrieve() {
		if (!ready || session.busy || pending.current) return;
		pending.current = true;
		const controller = new AbortController();
		request.current = controller;
		setSecret(''); setError(''); setLoading(true);
		session.setBusy(true);
		try {
			const value = await retrieveClaimSecret(session, owner, lockTxid, controller.signal);
			if (!controller.signal.aborted) setSecret(value);
		} catch (cause) { if (!controller.signal.aborted) setError(getErrorMessage(cause)); }
		finally {
			pending.current = false;
			if (!controller.signal.aborted) setLoading(false);
			session.setBusy(false);
		}
	}
	return { secret, loading, error, ready, retrieve, clear: () => setSecret('') };
}
