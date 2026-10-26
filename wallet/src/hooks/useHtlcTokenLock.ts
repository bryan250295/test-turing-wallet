import { useEffect, useRef, useState } from 'react';
import type { WalletAddresses, WalletSession } from '../types/wallet';
import type { Token } from '../types/api';
import type { HtlcTokenLockTerms, SignedTokenHtlc, TokenHtlcBroadcast, UnsignedTokenHtlc } from '../types/htlc';
import { getTokens } from '../services/tbcApi';
import { broadcastTokenHtlc, buildUnsignedTokenHtlc, finalizeTokenHtlc, getTokenHtlcSigningRequest } from '../services/unsignedTokenHtlc';
import { getErrorMessage } from '../utils/errors';
import { rememberHtlcSubmission } from '../services/htlcRequestHistory';
import { rememberLockRecipient } from '../services/recipientCache';

interface LockState {
	loading: boolean;
	tokens: Token[];
	unsigned: UnsignedTokenHtlc | null;
	signed: SignedTokenHtlc | null;
	broadcast: TokenHtlcBroadcast | null;
	error: string;
}

const initialState: LockState = { loading: false, tokens: [], unsigned: null, signed: null, broadcast: null, error: '' };

export default function useHtlcTokenLock(session: WalletSession) {
	const { address, networkIsDevnet, wallet } = session;
	const [state, setState] = useState(initialState);
	const request = useRef<AbortController | null>(null);
	const signing = useRef(false);
	const submitting = useRef(false);
	const ready = wallet.isReady && !!address && networkIsDevnet;

	useEffect(() => {
		setState(initialState);
		return () => request.current?.abort();
	}, [address, networkIsDevnet, wallet.isReady]);

	function reset() {
		request.current?.abort();
		setState((previous) => ({ ...previous, loading: false, unsigned: null, signed: null, broadcast: null, error: '' }));
	}

	async function run<T>(operation: (signal: AbortSignal) => Promise<T>, apply: (value: T, previous: LockState) => LockState, keepUnsigned = false, keepSigned = false) {
		request.current?.abort();
		if (!ready) {
			setState({ ...initialState, error: 'Connect a TBC Testnet account first.' });
			return;
		}
		const controller = new AbortController();
		request.current = controller;
		setState((previous) => ({ ...previous, loading: true, unsigned: keepUnsigned ? previous.unsigned : null, signed: keepSigned ? previous.signed : null, broadcast: keepSigned ? previous.broadcast : null, error: '' }));
		try {
			const value = await operation(controller.signal);
			if (!controller.signal.aborted) setState((previous) => apply(value, previous));
		} catch (cause) {
			if (!controller.signal.aborted) setState((previous) => ({ ...previous, loading: false, error: getErrorMessage(cause) }));
		}
	}

	async function loadTokens() {
		await run((signal) => getTokens(address, { signal }), (tokens) => ({ ...initialState, tokens }));
	}

	async function prepare(terms: HtlcTokenLockTerms) {
		await run(async (signal) => {
			async function verifyWallet() {
				const [network, account] = await Promise.all([wallet.getNetwork(), wallet.getAddress()]);
				signal.throwIfAborted();
				const addresses = account as WalletAddresses | undefined;
				if (network?.network !== 'tbc' || network.type !== 'testnet' || (addresses?.tbcAddress ?? addresses?.addresses?.tbcAddress) !== terms.sender) throw new Error('Your wallet account or network changed. Reconnect and try again.');
			}
			await verifyWallet();
			const unsigned = await buildUnsignedTokenHtlc(terms, signal);
			await verifyWallet();
			return unsigned;
		}, (unsigned, previous) => ({ ...previous, loading: false, unsigned, error: '' }));
	}

	async function signUnsigned(secretHex: string) {
		const transaction = state.unsigned;
		if (!transaction || signing.current || session.busy) return;
		signing.current = true;
		session.setBusy(true);
		try {
			await run(async (signal) => {
				if (!transaction.buildId) throw new Error('Build a new unsigned transaction to create a signing session.');
				async function verifyWallet() {
					const [network, account] = await Promise.all([wallet.getNetwork(), wallet.getAddress()]);
					signal.throwIfAborted();
					const addresses = account as WalletAddresses | undefined;
					if (network?.network !== 'tbc' || network.type !== 'testnet' || (addresses?.tbcAddress ?? addresses?.addresses?.tbcAddress) !== transaction!.plan.terms.sender) throw new Error('Select account A on TBC Testnet and rebuild if necessary.');
				}
				await verifyWallet();
				const signingRequest = await getTokenHtlcSigningRequest(transaction, signal);
				const publicKey = (await wallet.getPubKey())?.tbcPubKey;
				if (!publicKey) throw new Error('The wallet did not provide its public key.');
				await verifyWallet();
				const response = await wallet.signTransaction(signingRequest);
				signal.throwIfAborted();
				if (response?.error) throw new Error(response.error);
				if (!response?.sigs || response.sigs.length !== 1 || !Array.isArray(response.sigs[0]) || response.sigs[0].length !== transaction.inputs.length) throw new Error('The wallet did not return a signature for every input. It may have rejected the request or not support this FT signing flow.');
				await verifyWallet();
				const result = await finalizeTokenHtlc(transaction.buildId, publicKey, response.sigs[0], signal, secretHex);
				await verifyWallet();
				return result;
			}, (signed, previous) => ({ ...previous, loading: false, signed, error: '' }), true);
		} finally {
			signing.current = false;
			session.setBusy(false);
		}
	}

	async function submitSigned(checkOnly = false) {
		const transaction = state.unsigned;
		const signed = state.signed;
		if (!transaction?.buildId || !signed || submitting.current || session.busy) return;
		submitting.current = true;
		session.setBusy(true);
		try {
			await run(async (signal) => {
				const [network, account] = await Promise.all([wallet.getNetwork(), wallet.getAddress()]);
				signal.throwIfAborted();
				const addresses = account as WalletAddresses | undefined;
				if (network?.network !== 'tbc' || network.type !== 'testnet' || (addresses?.tbcAddress ?? addresses?.addresses?.tbcAddress) !== transaction.plan.terms.sender) throw new Error('Select account A on TBC Testnet before submitting or checking this transaction.');
				if (!checkOnly) await rememberHtlcSubmission(transaction, signed.txid);
				signal.throwIfAborted();
				const receipt = await broadcastTokenHtlc(transaction.buildId!, signed.txid, checkOnly, signal);
				await rememberHtlcSubmission(transaction, signed.txid, receipt);
				if (receipt.status === 'submitted') {
					const warning = rememberLockRecipient(transaction.plan.terms.receiver);
					if (warning) receipt.message += ` ${warning}`;
				}
				return receipt;
			}, (broadcast, previous) => ({ ...previous, loading: false, broadcast, error: '' }), true, true);
		} finally {
			submitting.current = false;
			session.setBusy(false);
		}
	}

	return { ...state, ready, loadTokens, prepare, signUnsigned, submitSigned, reset };
}
