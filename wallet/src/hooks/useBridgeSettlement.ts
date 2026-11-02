import { useEffect, useRef, useState } from 'react';
import type { WalletSession } from '../types/wallet';
import type { BridgeOrder, BridgeSettlement, BridgeCallAttempt, BridgeCallKind } from '../types/learningBridge';
import type useHyperEvmWallet from './useHyperEvmWallet';
import { beginCall, cancelCall, checkCall, checkDeposit, getSettlement, openPayment, quoteCall, rememberCallHash, savedCallHashes, submitCall } from '../services/bridgeSettlement';
import { getErrorMessage } from '../utils/errors';
import { evmWalletError } from '../services/evmWallet';

interface TokenImportState {
	context: string;
	status: 'idle' | 'added' | 'cancelled' | 'error';
	message: string;
}

export default function useBridgeSettlement(order: BridgeOrder, session: WalletSession, evm: ReturnType<typeof useHyperEvmWallet>, active: boolean, onChanged: () => void) {
	const enabled = active && session.networkIsDevnet && session.backendAuth.ready && session.address === order.sender && order.status === 'prepared';
	const context = JSON.stringify([enabled, session.address, evm.address, evm.chainId, order.id]);
	const current = useRef({ context, epoch: 0 });
	if (current.current.context !== context) current.current = { context, epoch: current.current.epoch + 1 };
	const epoch = current.current.epoch;
	const [state, setState] = useState<{ context: string; value: BridgeSettlement | null; loading: boolean; error: string }>({ context: '', value: null, loading: false, error: '' });
	const [action, setAction] = useState(''); const working = useRef(false); const request = useRef<AbortController | null>(null);
	const [revision, setRevision] = useState(0);
	const [tokenImport, setTokenImport] = useState<TokenImportState>({ context: '', status: 'idle', message: '' });
	const live = () => enabled && current.current.context === context && current.current.epoch === epoch;
	useEffect(() => {
		const controller = new AbortController();
		setState({ context, value: null, loading: enabled, error: '' });
		if (enabled) void (async () => {
			try {
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
				let value = await getSettlement(order, signal);
				let error = '';
				for (const [id, hash] of Object.entries(savedCallHashes(order))) {
					const row = value?.attempts.find((item) => item.id === id);
					if (!row || !value) continue;
					try { await submitCall(order, value, row, hash); rememberCallHash(order, id, null); value = await getSettlement(order, signal); }
					catch { error = `Transaction ${hash} is retained for recovery. Refresh after reconnecting the original TBC wallet; do not send again.`; }
				}
				if (!controller.signal.aborted) setState({ context, value, loading: false, error });
			} catch (cause) { if (!controller.signal.aborted) setState({ context, value: null, loading: false, error: getErrorMessage(cause) }); }
		})();
		return () => { controller.abort(); };
	}, [context, revision, enabled]);
	useEffect(() => () => { request.current?.abort(); }, [context]);
	async function run(label: string, operation: (signal: AbortSignal) => Promise<unknown>, notify = false) {
		if (!live() || working.current) return;
		working.current = true; setAction(label); setState((old) => ({ ...old, error: '' }));
		const controller = new AbortController(); request.current = controller;
		try {
			await operation(AbortSignal.any([controller.signal, AbortSignal.timeout(125_000)]));
			if (live() && !controller.signal.aborted) {
				const value = await getSettlement(order, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]));
				if (live()) { setState({ context, value, loading: false, error: '' }); if (notify || value?.status === 'completed') onChanged(); }
			}
		} catch (cause) {
			// Begin may have reserved a wallet request even when the provider check failed.
			// Restore the saved phase so Activity recovery / discard controls are visible.
			if (live() && label.startsWith('send:')) {
				try {
					const saved = await getSettlement(order, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]));
					if (live()) setState({ context, value: saved, loading: false, error: getErrorMessage(cause) });
				} catch {
					if (live()) setState((old) => ({ ...old, error: `${getErrorMessage(cause)} Refresh saved progress to recover the saved request.` }));
				}
			} else if (live()) setState((old) => ({ ...old, error: getErrorMessage(cause) }));
		}
		finally { working.current = false; request.current = null; setAction(''); }
	}
	const value = state.context === context ? state.value : null;
	const visibleImport = tokenImport.context === context ? tokenImport : { status: 'idle' as const, message: '' };
	async function importToken() {
		if (!live() || working.current || value?.status !== 'completed' || visibleImport.status === 'added') return;
		if (!evm.networkIsTestnet || evm.address?.toLowerCase() !== order.recipient.toLowerCase()) {
			setTokenImport({ context, status: 'error', message: 'Select the receiving MetaMask account on HyperEVM Testnet to add wrapped token.' });
			return;
		}
		working.current = true; setAction('import');
		setState((old) => ({ ...old, error: '' }));
		setTokenImport({ context, status: 'idle', message: '' });
		try {
			const accepted = await evm.watchWrappedToken(order.destinationContract, order.wrappedSymbol, order.decimals);
			if (!live()) return;
			if (accepted !== true && accepted !== false) throw new Error('MetaMask did not acknowledge token import. Check its Tokens tab before trying again.');
			setTokenImport({ context, status: accepted ? 'added' : 'cancelled', message: accepted
				? 'MetaMask acknowledged the import. Open Tokens to view your wrapped token balance.'
				: 'Token import cancelled. Your completed mint and wrapped token balance are unchanged.' });
		} catch (cause) {
			if (!live()) return;
			const cancelled = !!cause && typeof cause === 'object' && 'code' in cause && cause.code === 4001;
			setTokenImport({ context, status: cancelled ? 'cancelled' : 'error', message: cancelled
				? 'Token import cancelled. Your completed mint and wrapped token balance are unchanged.'
				: evmWalletError(cause) });
		} finally { working.current = false; setAction(''); }
	}
	return { value, context, enabled, action, loading: state.context === context && state.loading, error: state.context === context ? state.error : '',
		tokenImport: visibleImport,
		refresh: () => { if (!working.current) setRevision((old) => old + 1); },
		open: () => run('open', (signal) => openPayment(order, signal), true),
		deposit: (txid?: string) => run('deposit', (signal) => checkDeposit(order, txid, signal)),
		quote: (kind: BridgeCallKind | 'next') => run(`quote:${kind}`, async (signal) => {
			if (!value) return;
			const currentWallet = await evm.readCurrent();
			if (!live() || currentWallet.chainId !== 998 || !currentWallet.address || currentWallet.address.toLowerCase() !== evm.address?.toLowerCase()) throw new Error('Reconnect the expected MetaMask role account on Testnet.');
			return quoteCall(order, value, kind, currentWallet.address, signal);
		}),
		cancel: (row: BridgeCallAttempt) => run(`cancel:${row.id}`, async () => { if (value) await cancelCall(order, value, row); }),
		discardUnsent: (row: BridgeCallAttempt) => run(`cancel:${row.id}`, async () => { if (value) await cancelCall(order, value, row, true); }),
		check: (row: BridgeCallAttempt) => run(`check:${row.id}`, (signal) => checkCall(order, row, signal)),
		attach: (row: BridgeCallAttempt, hash: string) => run(`attach:${row.id}`, async () => {
			if (!value) return;
			await submitCall(order, value, row, hash.trim().toLowerCase()); rememberCallHash(order, row.id, null);
		}),
		send: (row: BridgeCallAttempt) => run(`send:${row.id}`, async (signal) => {
			if (!value) return;
			const authorized = await beginCall(order, value, row, signal);
			if (!live() || signal.aborted) throw new Error('Page or wallet changed before opening MetaMask. Refresh the saved call and check Activity.');
			let hash: string;
			try { hash = await evm.sendBridgeCall(authorized.transaction); }
			catch (cause) {
				if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 4001) { await cancelCall(order, value, row, true); throw new Error('Transaction rejected in MetaMask. No automatic retry will occur. Refresh saved progress.'); }
				throw new Error(`${getErrorMessage(cause)} Check MetaMask Activity and attach its hash before attempting another transaction.`);
			}
			rememberCallHash(order, row.id, hash);
			try { await submitCall(order, value, row, hash); rememberCallHash(order, row.id, null); }
			catch { throw new Error(`Transaction submitted: ${hash}. Its database save needs recovery. Reconnect the original TBC wallet and refresh saved progress; do not send again.`); }
		}),
		importToken,
	};
}
