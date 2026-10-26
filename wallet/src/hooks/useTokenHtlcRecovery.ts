import { useEffect, useRef, useState } from 'react';
import type { WalletAddresses, WalletSession } from '../types/wallet';
import type { SignedTokenHtlc, TokenHtlcBroadcast, TokenHtlcLock, UnsignedTokenHtlc } from '../types/htlc';
import { buildTokenHtlcRecovery, inspectTokenHtlc } from '../services/tokenHtlcRecovery';
import { broadcastTokenHtlc, finalizeTokenHtlc, getTokenHtlcSigningRequest } from '../services/unsignedTokenHtlc';
import { hashHtlcSecret } from '../utils/htlc';
import { getErrorMessage } from '../utils/errors';
import { rememberHtlcSubmission, rememberInspectedLock } from '../services/htlcRequestHistory';

interface RecoveryState {
	lock: TokenHtlcLock | null;
	unsigned: UnsignedTokenHtlc | null;
	signed: SignedTokenHtlc | null;
	receipt: TokenHtlcBroadcast | null;
	loading: boolean;
	error: string;
}
const initialState: RecoveryState = { lock: null, unsigned: null, signed: null, receipt: null, loading: false, error: '' };

export default function useTokenHtlcRecovery(session: WalletSession) {
	const [state, setState] = useState(initialState);
	const request = useRef<AbortController | null>(null);
	const busy = useRef(false);
	const ready = session.wallet.isReady && !!session.address && session.networkIsDevnet;

	function reset() {
		request.current?.abort();
		setState(initialState);
	}

	useEffect(() => {
		request.current?.abort();
		setState((previous) => ({ ...initialState, lock: previous.lock }));
		return () => request.current?.abort();
	}, [session.address, session.networkIsDevnet, session.wallet.isReady]);

	async function run(operation: (signal: AbortSignal) => Promise<Partial<RecoveryState>>, walletOperation = false) {
		if (busy.current || (walletOperation && session.busy)) return;
		busy.current = true;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setState((previous) => ({ ...previous, loading: true, error: '' }));
		if (walletOperation) session.setBusy(true);
		try {
			const result = await operation(controller.signal);
			if (!controller.signal.aborted) setState((previous) => ({ ...previous, ...result, loading: false, error: '' }));
		} catch (cause) {
			if (!controller.signal.aborted) setState((previous) => ({ ...previous, loading: false, error: getErrorMessage(cause) }));
		} finally {
			busy.current = false;
			if (walletOperation) session.setBusy(false);
		}
	}

	async function verifyAccount(address: string, signal: AbortSignal) {
		if (!ready) throw new Error('Connect the required account on TBC Testnet.');
		const [network, account] = await Promise.all([session.wallet.getNetwork(), session.wallet.getAddress()]);
		signal.throwIfAborted();
		const addresses = account as WalletAddresses | undefined;
		if (network?.network !== 'tbc' || network.type !== 'testnet' || (addresses?.tbcAddress ?? addresses?.addresses?.tbcAddress) !== address) throw new Error('The connected account does not match the required signer. Switch accounts in Turing Wallet and reconnect.');
	}

	async function load(lockTxid: string, contractId: string) {
		setState(initialState);
		await run(async (signal) => {
			const lock = await inspectTokenHtlc(lockTxid.trim().toLowerCase(), contractId.trim().toLowerCase(), signal);
			signal.throwIfAborted();
			await rememberInspectedLock(lock);
			return { lock, unsigned: null, signed: null, receipt: null };
		});
	}

	async function build(action: 'claim' | 'refund') {
		const lock = state.lock;
		if (!lock) return;
		setState((previous) => ({ ...previous, unsigned: null, signed: null, receipt: null }));
		await run(async (signal) => {
			const signer = action === 'claim' ? lock.receiver : lock.sender;
			await verifyAccount(signer, signal);
			const unsigned = await buildTokenHtlcRecovery(lock.lockTxid, lock.contractId, action, signal);
			await verifyAccount(signer, signal);
			return { unsigned, signed: null, receipt: null };
		});
	}

	async function sign(secret: string) {
		const transaction = state.unsigned;
		if (!transaction?.buildId || !transaction.signerAddress) return;
		await run(async (signal) => {
			if (transaction.action === 'claim' && await hashHtlcSecret(secret) !== transaction.plan.terms.hashHex) throw new Error('The secret does not match the on-chain hashlock.');
			await verifyAccount(transaction.signerAddress!, signal);
			const signingRequest = await getTokenHtlcSigningRequest(transaction, signal);
			const publicKey = (await session.wallet.getPubKey())?.tbcPubKey;
			if (!publicKey) throw new Error('The wallet did not return its public key.');
			await verifyAccount(transaction.signerAddress!, signal);
			const response = await session.wallet.signTransaction(signingRequest);
			signal.throwIfAborted();
			if (response?.error) throw new Error(response.error);
			if (response?.sigs?.length !== 1 || response.sigs[0]?.length !== 3) throw new Error('The wallet did not return all three recovery signatures.');
			await verifyAccount(transaction.signerAddress!, signal);
			const signed = await finalizeTokenHtlc(transaction.buildId!, publicKey, response.sigs[0], signal, transaction.action === 'claim' ? secret.trim().toLowerCase() : undefined);
			await verifyAccount(transaction.signerAddress!, signal);
			return { signed, receipt: null };
		}, true);
	}

	async function submit(checkOnly: boolean) {
		const transaction = state.unsigned;
		const signed = state.signed;
		if (!transaction?.buildId || !signed || !transaction.signerAddress) return;
		await run(async (signal) => {
			await verifyAccount(transaction.signerAddress!, signal);
			if (!checkOnly) await rememberHtlcSubmission(transaction, signed.txid);
			signal.throwIfAborted();
			const receipt = await broadcastTokenHtlc(transaction.buildId!, signed.txid, checkOnly, signal);
			await rememberHtlcSubmission(transaction, signed.txid, receipt);
			return { receipt };
		}, true);
	}

	return { ...state, ready, reset, load, build, sign, submit };
}
