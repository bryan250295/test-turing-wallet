import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { useTuringWallet } from 'turing-wallet-provider';
import { acceptBackendSession, backendData, getBackendSession, refreshBackendSession, subscribeBackendSession } from '../services/backendClient';
import type { BackendSession } from '../services/backendClient';
import { getErrorMessage } from '../utils/errors';

export interface WalletLoginAttempt {
	id: number;
	address: string;
}

function matchesWallet(session: BackendSession | null, address: string, networkIsDevnet: boolean) {
	return Boolean(networkIsDevnet && address && session?.identity.chain === 'tbc'
		&& session.identity.network === 'testnet' && session.identity.address === address
		&& Date.parse(session.expiresAt) > Date.now());
}

export default function useBackendSession(
	wallet: ReturnType<typeof useTuringWallet>,
	address: string,
	networkIsDevnet: boolean,
	connecting: boolean,
	connectionAttempt: WalletLoginAttempt | null,
) {
	const session = useSyncExternalStore(subscribeBackendSession, getBackendSession);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	const walletRef = useRef(wallet);
	const handledAttempt = useRef(0);
	walletRef.current = wallet;

	// Reading a previously authorized wallet only restores the existing session.
	// A fresh signature requires one explicit Connect/Reconnect action for this account.
	useEffect(() => {
		let active = true;
		setError('');
		if (connecting) {
			setPending(false);
			return;
		}
		const requestedLogin = Boolean(wallet.isReady && address && networkIsDevnet
			&& connectionAttempt?.address === address && connectionAttempt.id > handledAttempt.current);
		if (requestedLogin) handledAttempt.current = connectionAttempt!.id;

		async function verifyWallet() {
			if (!active) throw new Error('Wallet connection changed.');
			const [account, network] = await Promise.all([walletRef.current.getAddress(), walletRef.current.getNetwork()]);
			const value = account as { tbcAddress?: string; addresses?: { tbcAddress?: string } };
			if (!active || (value?.tbcAddress ?? value?.addresses?.tbcAddress) !== address
				|| network?.network !== 'tbc' || network.type !== 'testnet') {
				throw new Error('Your wallet changed. Reconnect on TBC Testnet.');
			}
		}

		async function connectSession() {
			setPending(true);
			try {
				const restored = await refreshBackendSession();
				if (!active || !walletRef.current.isReady || !address || !networkIsDevnet
					|| matchesWallet(restored, address, networkIsDevnet)) return;
				if (!requestedLogin) return;

				await verifyWallet();
				const challenge = await backendData('/api/auth/challenge', { chain: 'tbc', network: 'testnet', address }, false);
				if (!active) return;
				if (typeof challenge?.message !== 'string' || typeof challenge.challengeId !== 'string'
					|| challenge.address !== address || challenge.chain !== 'tbc' || challenge.network !== 'testnet'
					|| !challenge.message.startsWith('Sign in to Learning Bridge\n')
					|| !challenge.message.includes(`\nOrigin: ${window.location.origin}\n`)
					|| !challenge.message.includes(`\nAddress: ${address}\n`)) throw new Error('Invalid wallet login challenge.');
				await verifyWallet();
				const signed = await walletRef.current.signMessage({ message: challenge.message, encoding: 'utf8' });
				if (!active) return;
				if (signed?.error) throw new Error(signed.error);
				if (!signed?.sig) throw new Error('Login signature was cancelled.');
				await verifyWallet();
				const result = await backendData('/api/auth/verify', { challengeId: challenge.challengeId, signature: signed.sig }, false);
				await verifyWallet();
				if (!matchesWallet(result, address, networkIsDevnet)) throw new Error('Invalid wallet login response.');
				acceptBackendSession(result);
			} catch (cause) {
				if (active) setError(`${getErrorMessage(cause)} Reconnect to try again.`);
			} finally {
				if (active) setPending(false);
			}
		}

		void connectSession();
		return () => { active = false; };
	}, [address, networkIsDevnet, wallet.isReady, connecting, connectionAttempt]);

	useEffect(() => {
		if (!session) return;
		let active = true;
		const timer = window.setTimeout(() => {
			void refreshBackendSession().then((value) => {
				if (active && !matchesWallet(value, address, networkIsDevnet)) setError('Your connection expired. Reconnect to continue.');
			}).catch(() => {
				if (active) setError('Could not restore your connection. Reconnect to try again.');
			});
		}, Math.max(0, Date.parse(session.expiresAt) - Date.now()) + 100);
		return () => { active = false; window.clearTimeout(timer); };
	}, [session, address, networkIsDevnet]);

	return { ready: matchesWallet(session, address, networkIsDevnet), pending, error };
}
