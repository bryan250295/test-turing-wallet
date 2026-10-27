import { useEffect, useRef, useState } from 'react';
import { HYPEREVM_TESTNET } from '../config/hyperevm';
import { evmWalletError, isEvmProvider, legacyMetaMask, readEvmWallet, switchToHyperEvmTestnet, withWalletReadTimeout } from '../services/evmWallet';
import type { EvmProvider, EvmWalletSnapshot } from '../types/evm';

export default function useHyperEvmWallet(active: boolean) {
	const [provider, setProvider] = useState<EvmProvider | null>(null);
	const [snapshot, setSnapshot] = useState<EvmWalletSnapshot | null>(null);
	const [loading, setLoading] = useState(false);
	const [pending, setPending] = useState<'connect' | 'switch' | null>(null);
	const [error, setError] = useState('');
	const reader = useRef<{ refresh: () => void } | null>(null);
	const command = useRef(false);
	const lifecycle = useRef(0);
	const mounted = useRef(false);

	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);

	useEffect(() => {
		if (!active) return;
		function announced(event: Event) {
			const detail: unknown = (event as CustomEvent).detail;
			if (!detail || typeof detail !== 'object' || !('info' in detail) || !('provider' in detail)) return;
			const info = detail.info;
			if (info && typeof info === 'object' && 'rdns' in info && info.rdns === 'io.metamask' && isEvmProvider(detail.provider)) {
				setProvider(detail.provider);
			}
		}
		window.addEventListener('eip6963:announceProvider', announced);
		window.dispatchEvent(new Event('eip6963:requestProvider'));
		setProvider((current) => current ?? legacyMetaMask());
		return () => window.removeEventListener('eip6963:announceProvider', announced);
	}, [active]);

	useEffect(() => {
		const epoch = ++lifecycle.current;
		setSnapshot(null);
		setError('');
		setLoading(false);
		if (!active || !provider) return;
		const walletProvider = provider;
		let alive = true;
		let version = 0;
		let running = false;
		let queued = false;

		// Coalesce overlapping refresh/events into one active read and one latest read.
		async function refresh() {
			if (!alive) return;
			version++;
			setSnapshot(null);
			setLoading(true);
			setError('');
			if (running) { queued = true; return; }
			running = true;
			do {
				queued = false;
				const requestVersion = version;
				try {
					const next = await withWalletReadTimeout(readEvmWallet(walletProvider));
					if (alive && version === requestVersion) setSnapshot(next);
				} catch (cause) {
					if (alive && version === requestVersion) setError(evmWalletError(cause));
				}
			} while (alive && queued);
			running = false;
			if (alive) setLoading(false);
		}

		const changed = () => { void refresh(); };
		const disconnected = () => {
			version++;
			queued = false;
			setSnapshot(null);
			setLoading(false);
			setError('MetaMask is disconnected. Open the extension and reconnect.');
		};
		reader.current = { refresh: changed };
		provider.on('accountsChanged', changed);
		provider.on('chainChanged', changed);
		provider.on('connect', changed);
		provider.on('disconnect', disconnected);
		void refresh();
		return () => {
			alive = false;
			lifecycle.current = epoch + 1;
			reader.current = null;
			provider.removeListener('accountsChanged', changed);
			provider.removeListener('chainChanged', changed);
			provider.removeListener('connect', changed);
			provider.removeListener('disconnect', disconnected);
		};
	}, [active, provider]);

	async function run(action: 'connect' | 'switch') {
		if (!active || command.current) return;
		if (!provider) {
			window.dispatchEvent(new Event('eip6963:requestProvider'));
			const fallback = legacyMetaMask();
			if (fallback) setProvider(fallback);
			setError('MetaMask was not detected. Install or enable its browser extension, then reload this page.');
			return;
		}
		const epoch = lifecycle.current;
		command.current = true;
		setPending(action);
		setError('');
		try {
			if (action === 'connect') await provider.request({ method: 'eth_requestAccounts' });
			else await switchToHyperEvmTestnet(provider);
			if (lifecycle.current === epoch) reader.current?.refresh();
		} catch (cause) {
			if (lifecycle.current === epoch) setError(evmWalletError(cause));
		} finally {
			// Tab changes invalidate reads, but must not start a second approval prompt.
			command.current = false;
			if (mounted.current) setPending(null);
		}
	}

	return {
		...snapshot,
		detected: provider !== null,
		loading,
		pending,
		error,
		networkIsTestnet: snapshot?.chainId === HYPEREVM_TESTNET.chainId,
		connect: () => run('connect'),
		switchNetwork: () => run('switch'),
		refresh: () => reader.current?.refresh(),
	};
}
